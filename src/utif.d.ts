declare module "utif" {
  export interface TiffIfd {
    width?: number;
    height?: number;
    data?: Uint8Array;
    t256?: number[];
    t257?: number[];
    [tag: string]: unknown;
  }

  interface UtifApi {
    decode(buffer: ArrayBuffer): TiffIfd[];
    decodeImage(buffer: ArrayBuffer, ifd: TiffIfd): void;
    toRGBA8(ifd: TiffIfd): Uint8Array;
    encodeImage(rgba: ArrayBuffer, width: number, height: number, metadata?: TiffIfd): ArrayBuffer;
  }

  const UTIF: UtifApi;
  export default UTIF;
}
