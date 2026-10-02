/** Android sparse image v1 wire layout (system/core/libsparse/sparse_format.h). */
export type ImageExtent = { offset: number; length: number; dataOffset?: number; fill?: Uint8Array };
export interface ImageFootprint { length: number; sparse: boolean; extents: ImageExtent[]; skipped: number }
export async function imageFootprint(image: Blob): Promise<ImageFootprint> {
  const header = new DataView(await image.slice(0, 28).arrayBuffer());
  if (header.byteLength < 4 || header.getUint32(0, true) !== 0xed26ff3a) return { length:image.size, sparse:false, extents:[{offset:0,length:image.size,dataOffset:0}], skipped:0 };
  if (header.byteLength < 28 || header.getUint16(4,true) !== 1) throw new Error("Unsupported or truncated Android sparse image header.");
  const fileHeader = header.getUint16(8,true), chunkHeader = header.getUint16(10,true), blockSize = header.getUint32(12,true), blockCount = header.getUint32(16,true), count = header.getUint32(20,true);
  if (fileHeader < 28 || chunkHeader < 12 || !blockSize || blockSize % 4 || !Number.isSafeInteger(blockCount * blockSize)) throw new Error("Invalid Android sparse image geometry.");
  const extents: ImageExtent[] = [];
  let fileOffset = fileHeader, offset = 0, skipped = 0;
  for (let i = 0; i < count; i++) {
    const chunk = new DataView(await image.slice(fileOffset, fileOffset+chunkHeader).arrayBuffer());
    if (chunk.byteLength !== chunkHeader) throw new Error("Truncated Android sparse chunk header.");
    const type=chunk.getUint16(0,true), blocks=chunk.getUint32(4,true), size=chunk.getUint32(8,true), length=blocks*blockSize;
    if (size < chunkHeader || fileOffset+size>image.size || offset+length>blockCount*blockSize) throw new Error("Android sparse chunk exceeds the image bounds.");
    const dataOffset=fileOffset+chunkHeader, dataLength=size-chunkHeader;
    if (type===0xcac1 && dataLength===length) extents.push({offset,length,dataOffset});
    else if (type===0xcac2 && dataLength===4) extents.push({offset,length,fill:new Uint8Array(await image.slice(dataOffset,dataOffset+4).arrayBuffer())});
    else if (type===0xcac3 && dataLength===0) skipped+=length;
    else if (type===0xcac4 && dataLength===4 && blocks===0) { /* Optional CRC, input integrity is bound by SHA-256. */ }
    else throw new Error("Unsupported or malformed Android sparse chunk.");
    offset+=length; fileOffset+=size;
  }
  if (fileOffset!==image.size || offset!==blockCount*blockSize) throw new Error("Android sparse image length does not match its header.");
  return {length:offset,sparse:true,extents,skipped};
}
