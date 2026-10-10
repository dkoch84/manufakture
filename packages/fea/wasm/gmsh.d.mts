// Types for the Emscripten glue that build/build-gmsh.sh writes next to this file (gmsh.mjs).
// Only what src/gmsh.ts uses: the exported C API functions (build/exported-functions.json) and
// the runtime methods the link exports.

export interface GmshModuleOptions {
  wasmMemory?: WebAssembly.Memory;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  locateFile?: (path: string, prefix: string) => string;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object;
  onAbort?: (what: unknown) => void;
}

export interface GmshFS {
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
}

export interface GmshModule {
  FS: GmshFS;
  wasmMemory: WebAssembly.Memory;
  UTF8ToString(ptr: number): string;
  stringToUTF8(text: string, ptr: number, max: number): void;
  lengthBytesUTF8(text: string): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _gmshFree(ptr: number): void;
  _gmshInitialize(
    argc: number,
    argv: number,
    readConfigFiles: number,
    run: number,
    ierr: number,
  ): void;
  _gmshFinalize(ierr: number): void;
  _gmshClear(ierr: number): void;
  _gmshOptionSetNumber(name: number, value: number, ierr: number): void;
  _gmshOptionSetString(name: number, value: number, ierr: number): void;
  _gmshModelAdd(name: number, ierr: number): void;
  _gmshModelGetEntities(dimTags: number, dimTagsN: number, dim: number, ierr: number): void;
  _gmshModelGetBoundary(
    dimTags: number,
    dimTagsN: number,
    outDimTags: number,
    outDimTagsN: number,
    combined: number,
    oriented: number,
    recursive: number,
    ierr: number,
  ): void;
  _gmshModelGetBoundingBox(
    dim: number,
    tag: number,
    xmin: number,
    ymin: number,
    zmin: number,
    xmax: number,
    ymax: number,
    zmax: number,
    ierr: number,
  ): void;
  _gmshModelOccImportShapes(
    fileName: number,
    outDimTags: number,
    outDimTagsN: number,
    highestDimOnly: number,
    format: number,
    ierr: number,
  ): void;
  _gmshModelOccFragment(
    objectDimTags: number,
    objectDimTagsN: number,
    toolDimTags: number,
    toolDimTagsN: number,
    outDimTags: number,
    outDimTagsN: number,
    outDimTagsMap: number,
    outDimTagsMapN: number,
    outDimTagsMapNN: number,
    tag: number,
    removeObject: number,
    removeTool: number,
    ierr: number,
  ): void;
  _gmshModelOccGetMass(dim: number, tag: number, mass: number, ierr: number): void;
  _gmshModelOccSynchronize(ierr: number): void;
  _gmshModelMeshGenerate(dim: number, ierr: number): void;
  _gmshModelMeshSetSize(dimTags: number, dimTagsN: number, size: number, ierr: number): void;
  _gmshModelMeshGetNodes(
    nodeTags: number,
    nodeTagsN: number,
    coord: number,
    coordN: number,
    parametricCoord: number,
    parametricCoordN: number,
    dim: number,
    tag: number,
    includeBoundary: number,
    returnParametricCoord: number,
    ierr: number,
  ): void;
  _gmshModelMeshGetElementsByType(
    elementType: number,
    elementTags: number,
    elementTagsN: number,
    nodeTags: number,
    nodeTagsN: number,
    tag: number,
    task: number,
    numTasks: number,
    ierr: number,
  ): void;
  _gmshModelMeshFieldAdd(fieldType: number, tag: number, ierr: number): number;
  _gmshModelMeshFieldSetNumber(tag: number, option: number, value: number, ierr: number): void;
  _gmshModelMeshFieldSetNumbers(
    tag: number,
    option: number,
    values: number,
    valuesN: number,
    ierr: number,
  ): void;
  _gmshModelMeshFieldSetAsBackgroundMesh(tag: number, ierr: number): void;
  _gmshLoggerGetLastError(error: number, ierr: number): void;
}

declare const createGmsh: (options?: GmshModuleOptions) => Promise<GmshModule>;
export default createGmsh;
