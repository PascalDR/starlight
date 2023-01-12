import path from 'path';

/**
 * Trims unused spaces from a string
 * 
 * @param line - The line to trim.
 * @returns The resulting trimmed string
 */
export const trim = (line: string): string => line.replace(/\s+/g, ' ').replace(/^\s/, '');

export const isImport = (line: string): boolean => line.startsWith('import');

const handleImport = (line: string, options: any) => {
    const filePath     = line.substring(8, line.length - 3);
    const importPath   = path.resolve(path.dirname(options.inputFilePath), filePath);
    const relativePath = path.relative(options.topDir, importPath);
  
    return {importPath, relativePath};
};

const genImportOptions = (i: string, {inputFilePath, topDir}: any) => ({
    inputFilePath: `${path.dirname(inputFilePath)}/${i.substring(8, i.length - 3)}`,
    topDir
});

export const extractImports = (source: string, options: any) =>
    source
        .split('\n')
        .filter(isImport)
        .map(trim)
        .map(x => handleImport(x, genImportOptions(x, options)));