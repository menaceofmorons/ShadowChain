export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface CodeSize {
  readonly bytes: number;
  readonly nonBlankLines: number;
}

const encoder = new TextEncoder();

export const measureCodeSize = (files: readonly SourceFile[]): CodeSize => {
  let bytes = 0;
  let nonBlankLines = 0;
  for (const file of files) {
    bytes += encoder.encode(file.text).length;
    nonBlankLines += file.text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  }
  return { bytes, nonBlankLines };
};
