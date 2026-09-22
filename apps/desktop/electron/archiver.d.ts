declare module 'archiver' {
  interface ArchiveProgress {
    entries: { processed: number; total: number };
  }

  interface Archive {
    on(event: 'progress', listener: (progress: ArchiveProgress) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'warning', listener: (warning: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'end', listener: () => void): this;
    pipe(destination: NodeJS.WritableStream): this;
    directory(directoryPath: string, destPath: string | false): this;
    file(filePath: string, options?: { name: string }): this;
    append(source: Buffer | string, options: { name: string }): this;
    finalize(): Promise<void>;
  }

  interface ArchiverOptions {
    zlib?: { level?: number };
    store?: boolean;
  }

  interface ArchiverStatic {
    (format: string, options?: ArchiverOptions): Archive;
  }

  const archiver: ArchiverStatic;
  export default archiver;
}
