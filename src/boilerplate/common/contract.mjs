import fs from 'fs';
import config from 'config';
import pkg from 'general-number';
import utils from 'zkp-utils';
import Web3 from './web3.mjs';
import logger from './logger.mjs';
import { generateProof } from './zokrates.mjs';
import { scalarMult, compressStarlightKey, poseidonHash } from './number-theory.mjs';

const web3 = Web3.connection();
const { generalise, GN } = pkg;
const db = '/app/orchestration/common/db/preimage.json';
const keyDb = '/app/orchestration/common/db/key.json';

export const contractPath = contractName => {
  return `/app/build/contracts/${contractName}.json`;
};

const { options } = config.web3;

export async function getContractInterface(contractName) {
  const path = contractPath(contractName);
  const contractInterface = JSON.parse(fs.readFileSync(path, 'utf8'));
  // logger.debug('\ncontractInterface:', contractInterface);
  return contractInterface;
}

export async function getContractAddress(contractName) {
  let deployedAddress;
  let errorCount = 0;

  if (!deployedAddress) {
    while (errorCount < 25) {
      try {
        const contractInterface = await getContractInterface(contractName);
        const networkId = await web3.eth.net.getId();
        logger.silly('networkId:', networkId);

        if (
          contractInterface &&
          contractInterface.networks &&
          contractInterface.networks[networkId]
        ) {
          deployedAddress = contractInterface.networks[networkId].address;
        }
        if (deployedAddress === undefined) throw new Error('Shield address was undefined');
        if (deployedAddress) break;
      } catch (err) {
        errorCount++;
        logger.warn('Unable to get a contract address - will try again in 5 seconds');
        await new Promise(resolve => setTimeout(() => resolve(), 5000));
      }
    }
  }

  logger.silly('deployed address:', deployedAddress);
  return deployedAddress;
}

// returns a web3 contract instance
export async function getContractInstance(contractName, deployedAddress) {
  const contractInterface = await getContractInterface(contractName);
  if (!deployedAddress) {
    // eslint-disable-next-line no-param-reassign
    deployedAddress = await getContractAddress(contractName);
  }

  const contractInstance = deployedAddress
    ? new web3.eth.Contract(contractInterface.abi, deployedAddress, options)
    : new web3.eth.Contract(contractInterface.abi, null, options);
  // logger.silly('\ncontractInstance:', contractInstance);
  logger.info(`${contractName} Address: ${deployedAddress}`);

  return contractInstance;
}

export async function getContractBytecode(contractName) {
  const contractInterface = await getContractInterface(contractName);
  return contractInterface.evm.bytecode.object;
}

export async function deploy(userAddress, userAddressPassword, contractName, constructorParams) {
  logger.info(`\nUnlocking account ${userAddress}...`);
  await web3.eth.personal.unlockAccount(userAddress, userAddressPassword, 1);

  const contractInstance = await getContractInstance(contractName); // get a web3 contract instance of the contract
  const bytecode = await getContractBytecode(contractName);

  const deployedContractAddress = await contractInstance
    .deploy({ data: `0x${bytecode}`, arguments: constructorParams })
    .send({
      from: userAddress,
      gas: config.web3.options.defaultGas,
    })
    .on('error', err => {
      throw new Error(err);
    })
    .then(deployedContractInstance => {
      // logger.silly('deployed contract instance:', deployedContractInstance);
      logger.info(
        `${contractName} contract deployed at address ${deployedContractInstance.options.address}`,
      ); // instance with the new contract address

      return deployedContractInstance.options.address;
    });
  return deployedContractAddress;
}

export async function registerKey(
  _secretKey,
  contractName,
  registerWithContract,
) {
  let secretKey = generalise(_secretKey);
  let publicKeyPoint = generalise(
    scalarMult(secretKey.hex(32), config.BABYJUBJUB.GENERATOR),
  );
  let publicKey = compressStarlightKey(publicKeyPoint);
  while (publicKey === null) {
    logger.warn(`your secret key created a large public key - resetting`);
    secretKey = generalise(utils.randomHex(31));
    publicKeyPoint = generalise(
      scalarMult(secretKey.hex(32), config.BABYJUBJUB.GENERATOR),
    );
    publicKey = compressStarlightKey(publicKeyPoint);
  }
  if (registerWithContract) {
    const instance = await getContractInstance(contractName);
    await instance.methods.registerZKPPublicKey(publicKey.integer).send({
      from: config.web3.options.defaultAccount,
      gas: config.web3.options.defaultGas,
    });
  }
  const keyJson = {
    secretKey: secretKey.integer,
    publicKey: publicKey.integer, // not req
  };
  fs.writeFileSync(keyDb, JSON.stringify(keyJson, null, 4));

  return publicKey;
}

function getStructInputCommitments(
	value,
	possibleCommitments
) {
	let possibleCommitmentsProp = [];
	value.forEach((propValue, i) => {
		let possibleCommitmentsTemp = [];
		possibleCommitments.sort(
			(preimageA, preimageB) =>
				parseInt(Object.values(preimageB[1].value)[0], 10) -
				parseInt(Object.values(preimageA[1].value)[0], 10)
		);
		if(possibleCommitmentsProp.length === 0){
			if (
					parseInt(Object.values(possibleCommitments[0][1].value)[i], 10) +
						parseInt(Object.values(possibleCommitments[1][1].value)[i], 10) >
					parseInt(propValue, 10)
				) {
					possibleCommitmentsProp.push([
						possibleCommitments[0][0],
						possibleCommitments[1][0],
					]);
				}
		}
		else {
			possibleCommitmentsProp.forEach((commitment) => {
				commitment.forEach((item) => {
				 possibleCommitments.forEach((possibleCommit) => {
					 if(item === possibleCommit[0]){
						possibleCommitmentsTemp.push(possibleCommit)
					 }
				  });
				})
			})
			if (
					parseInt(Object.values(possibleCommitmentsTemp[0][1].value)[i], 10) +
						parseInt(Object.values(possibleCommitmentsTemp[1][1].value)[i], 10) <
					parseInt(propValue, 10)
				) {
					possibleCommitments.splice(0,2);
				  possibleCommitmentsProp = getStructInputCommitments(value, possibleCommitments);
			 }
       else {
         logger.warn('Enough Commitments dont exists to use.' )
         return null;
       }
		}
});
return possibleCommitmentsProp;
}

// this fn is useful for checking decrypted values match some existing commitment
// expecting search term in the form { key: value }
export function searchPartitionedCommitments(commitmentSet, searchTerm) {
  // for a mapping, we have commitments stored by:
  // stateName.mappingKeyName.commitmentHash
  let allCommitments = [];
  const stateNames = Object.keys(commitmentSet);
  stateNames.forEach((stateName) => {
    if (Object.entries(commitmentSet[stateName])[0][1].salt) {
      // isMapping = false;
      allCommitments = allCommitments.concat(Object.values(commitmentSet[stateName]));
    } else {
      Object.keys(commitmentSet[stateName]).forEach(mappingKey => {
        allCommitments = allCommitments.concat(
          Object.values(commitmentSet[stateName][mappingKey]),
        );
      });
    }
  });
  const [key, value] = Object.entries(searchTerm)[0];
  let foundValue = false;
  allCommitments.forEach(commitment => {
    if (commitment[key] === generalise(value).integer) {
			foundValue = true;
		}
  });
  return foundValue;
}

export function getInputCommitments(publicKey, value, commitments, isStruct = false) {
  const possibleCommitments = Object.entries(commitments).filter(
    entry => entry[1].publicKey === publicKey && !entry[1].isNullified,
  );
  if (isStruct) {
		let possibleCommitmentsProp = getStructInputCommitments(value, possibleCommitments);
		if (
			possibleCommitmentsProp.length > 0
		)
			return [possibleCommitmentsProp[0][0], possibleCommitmentsProp[0][1]];
		return null;
	}
  possibleCommitments.sort(
    (preimageA, preimageB) =>
      parseInt(preimageB[1].value, 10) - parseInt(preimageA[1].value, 10),
  );
  var commitmentsSum = 0;
  console.log('Commitment Sum:', commitmentsSum);
	for (var i = 0; i < possibleCommitments.length; i++) {
	  for (var j = 0 ;  j < possibleCommitments.length; j++){
		 if(possibleCommitments[i][j] && possibleCommitments[i][j].value)
		 commitmentsSum = commitmentsSum + parseInt(possibleCommitments[i][j].value, 10);
	  }
	}
  console.log('Commitment Sum:', commitmentsSum);
  if (
    parseInt(possibleCommitments[0][1].value, 10) +
      parseInt(possibleCommitments[1][1].value, 10) >
    parseInt(value, 10)
  ) {
    return [true, possibleCommitments[0][0], possibleCommitments[1][0]];
  } else if(commitmentsSum >=   parseInt(value, 10))
	 return  [false, possibleCommitments[0][0], possibleCommitments[1][0]];
  return null;
}
  export async function joinCommitments(contractName, statename, secretKey, publicKey, stateVarId, commitments, commitmentsID, witnesses, instance, isStruct = false, structProperties = []){

  logger.warn('Existing Commitments are not appropriate and we need to call Join Commitment Circuit. It will generate proof to join commitments, this will require an on-chain verification');
  const oldCommitment_0 = commitmentsID[0];

	const oldCommitment_1 = commitmentsID[1];

	const oldCommitment_0_prevSalt = generalise(commitments[oldCommitment_0].salt);
	const oldCommitment_1_prevSalt = generalise(commitments[oldCommitment_1].salt);
	const oldCommitment_0_prev = generalise(commitments[oldCommitment_0].value);
	const oldCommitment_1_prev = generalise(commitments[oldCommitment_1].value);

	// Extract set membership witness:

	const oldCommitment_0_witness = witnesses[0];
	const oldCommitment_1_witness = witnesses[1];


	const oldCommitment_0_index = generalise(oldCommitment_0_witness.index);
	const oldCommitment_1_index = generalise(oldCommitment_1_witness.index);
	const oldCommitment_root = generalise(oldCommitment_0_witness.root);
	const oldCommitment_0_path = generalise(oldCommitment_0_witness.path).all;
	const oldCommitment_1_path = generalise(oldCommitment_1_witness.path).all;

	// increment would go here but has been filtered out

	// Calculate nullifier(s):

   let oldCommitment_stateVarId = stateVarId[0];
   if(stateVarId.length > 1){
       oldCommitment_stateVarId =  generalise(
         utils.mimcHash(
           [
             generalise(stateVarId[0]).bigInt,
             generalise(stateVarId[1]).bigInt,
           ],
           "ALT_BN_254"
         )
       ).hex(32);
     }



	let oldCommitment_0_nullifier = poseidonHash([
		BigInt(oldCommitment_stateVarId), BigInt(secretKey.hex(32)), BigInt(oldCommitment_0_prevSalt.hex(32))
  ],);
	let oldCommitment_1_nullifier = poseidonHash([
		BigInt(oldCommitment_stateVarId), BigInt(secretKey.hex(32)), BigInt(oldCommitment_1_prevSalt.hex(32))
  ],);
	oldCommitment_0_nullifier = generalise(oldCommitment_0_nullifier.hex(32)); // truncate
	oldCommitment_1_nullifier = generalise(oldCommitment_1_nullifier.hex(32)); // truncate

	// Calculate commitment(s):

	const newCommitment_newSalt = generalise(utils.randomHex(32));

  let newCommitment_value = [];
  let oldCommitment_0_value = [];
  let oldCommitment_1_value = [];
  let newCommitment;

  if(structProperties){
    Object.keys(oldCommitment_0_prev).forEach(
				(p, i) => oldCommitment_0_value[i] = parseInt(oldCommitment_0_prev[p].integer, 10));

    Object.keys(oldCommitment_1_prev).forEach(
				(p, i) => oldCommitment_1_value[i] = parseInt(oldCommitment_1_prev[p].integer, 10));

    Object.keys(oldCommitment_0_prev).forEach(
				(p, i) =>
				newCommitment_value[i] = parseInt(oldCommitment_0_prev[p].integer, 10) +
					parseInt(oldCommitment_1_prev[p].integer, 10)
		  );
    newCommitment_value = generalise(newCommitment_value).all;

     newCommitment = poseidonHash([
  		BigInt(oldCommitment_stateVarId),
  		...newCommitment_value.hex(32).map((v) => BigInt(v)),
  		BigInt(publicKey.hex(32)),
  		BigInt(newCommitment_newSalt.hex(32)),
  	]);
  } else{

    oldCommitment_0_value = parseInt(oldCommitment_0_prev.integer, 10) ;
    oldCommitment_1_value = parseInt(oldCommitment_1_prev.integer, 10) ;

    newCommitment_value = parseInt(oldCommitment_0_prev.integer, 10) +
      parseInt(oldCommitment_1_prev.integer, 10);

  	newCommitment_value = generalise(newCommitment_value);

     newCommitment = poseidonHash([
  			BigInt(oldCommitment_stateVarId),
  			BigInt(newCommitment_value.hex(32)),
  			BigInt(publicKey.hex(32)),
  			BigInt(newCommitment_newSalt.hex(32))
    ]);
  }

	newCommitment = generalise(newCommitment.hex(32)); // truncate

  let stateVarID = parseInt(oldCommitment_stateVarId,16);
  let  fromID = 0;
  let isMapping=0;
  if(stateVarId.length > 1 ){
    stateVarID  = stateVarId[0];
    fromID = stateVarId[1].integer;;
     isMapping = 1;
  }


// Call Zokrates to generate the proof:
const allInputs = [
fromID,
stateVarID,
isMapping,
secretKey.limbs(32, 8),
secretKey.limbs(32, 8),
oldCommitment_0_nullifier.integer,
oldCommitment_1_nullifier.integer,
oldCommitment_0_value,
oldCommitment_0_prevSalt.integer,
oldCommitment_1_value,
oldCommitment_1_prevSalt.integer,
oldCommitment_root.integer,
oldCommitment_0_index.integer,
oldCommitment_0_path.integer,
oldCommitment_1_index.integer,
oldCommitment_1_path.integer,
publicKey.integer,
newCommitment_newSalt.integer,
newCommitment.integer,
].flat(Infinity);

const res = await generateProof( "joinCommitments", allInputs);
const proof = generalise(Object.values(res.proof).flat(Infinity))
.map((coeff) => coeff.integer)
.flat(Infinity);

// Send transaction to the blockchain:

const tx = await instance.methods
.joinCommitments(
  [oldCommitment_0_nullifier.integer, oldCommitment_1_nullifier.integer,],
  oldCommitment_root.integer,
  [newCommitment.integer],
  proof
).send({
  from: config.web3.options.defaultAccount,
  gas: config.web3.options.defaultGas,
});

      let preimage = {};
      if (fs.existsSync(db)) {
        preimage = JSON.parse(
          fs.readFileSync(db, "utf-8", (err) => {
            console.log(err);
          })
        );
      }

      Object.keys(preimage).forEach((key) => {
    		if (key === statename) {
    			preimage[key][oldCommitment_0].isNullified = true;
    			preimage[key][oldCommitment_1].isNullified = true;
    			preimage[key][newCommitment.hex(32)] = {
    				value: newCommitment_value.integer,
    				salt: newCommitment_newSalt.integer,
    				publicKey: publicKey.integer,
    				commitment: newCommitment.integer,
    			}
    		}

    			else	if (key === statename.split('[')[0]){
    					Object.keys(preimage[key]).forEach((id) => {
    						if(parseInt(id,10) === parseInt(fromID,10)){
    							preimage[key][id][oldCommitment_0].isNullified = true;
    							preimage[key][id][oldCommitment_1].isNullified = true;
    							preimage[key][id][newCommitment.hex(32)] = {
    								value: newCommitment_value.integer,
    								salt: newCommitment_newSalt.integer,
    								publicKey: publicKey.integer,
    								commitment: newCommitment.integer,
    						}
    					}
    					})
    				}
    			fs.writeFileSync(db, JSON.stringify(preimage, null, 4));
       });

  return { tx };
}
