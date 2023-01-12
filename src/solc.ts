import solc from 'solc';
import path from 'path';
import fs from 'fs/promises';
import logger from './utils/logger.js';
import { FilingError } from './error/errors.js';
import { extractImports } from './utils/compilation.js';

type ImportDecl  = {importPath: string, relativePath: string};
type FileHandler = {path: string, imports: ImportDecl[], content: string};

const handleZolFile = (file: string, options: any): FileHandler =>
  ({path: options.inputFilePath, imports: extractImports(file, options), content: file})

const handleSolFile = async(filePath: string, options: any): Promise<FileHandler> =>
  fs.readFile(filePath, 'utf-8')
    .then(file => ({path: filePath, imports: extractImports(file, options), content: file}))

const prepareSources = async(rootFile: string, options: any): Promise<{[key: string]: any}> => {
  const isSolidityFile = (imp: ImportDecl) => path.extname(imp.importPath) == '.sol';

  if (!options.topDir) options.topDir = path.dirname(options.inputFilePath);

  const rootData = handleZolFile(rootFile, options);

  const importsHandlers = 
    await Promise.all(
      rootData.imports
        .filter(isSolidityFile)
        .map(x => handleSolFile(x.relativePath, options)));

  const filesObject =
    importsHandlers
      .reduce((acc, x) => {
        acc[x.path] = {content: x.content};
        return acc;
      }, {input: {content: rootData.content}});

  return filesObject;
}

const createSolcInput = (sources: {[key: string]: any}) => ({
  language: 'Solidity',
  sources,
  settings: {outputSelection: {'*': {'*': [], '': ['ast']}}}
});

/**
 * Shows when there were errors during compilation.
 * @param {Object} compiled - the output object from running solc
 */
const errorHandling = (compiled: any) => {
  if (!compiled) {
    throw new FilingError(`solc didn't create any output...`);
  } else if (compiled.errors) {
    // something went wrong.
    logger.error(`solc errors:`);
    compiled.errors.map((error: any) => logger.error(error.formattedMessage));
    throw new FilingError(
      `Solc Compilation Error: Make sure your .sol contract compiles without Zappify decorators.`
    );
  }
};

/**
  Compiles a solidity file and saves the output(s) (namely the AST) to file.
*/
export const compile = async(rootSource: string, options: any) => {
  const sources  = await prepareSources(rootSource, options);
  const params   = createSolcInput(sources);
  const compiled = JSON.parse(solc.compile(JSON.stringify(params)));

  logger.debug('compiled', compiled);
  errorHandling(compiled);

  const ast = compiled.sources.input.ast;

  const astFilePath = `${options.parseDirPath}/${options.inputFileName}_dedecorated.sol_ast.json`;

  logger.debug('filepath', astFilePath);
  await fs.writeFile(astFilePath, JSON.stringify(ast, null, 4));

  return ast;
};