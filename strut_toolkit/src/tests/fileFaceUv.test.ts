import { fileFaceUv } from '../ts/binary/cubeUv';

describe('fileFaceUv', () => {
  // from a real model: Blockbench's rectangles and the geometry file Blockbench wrote for the same cube (uv origin and uv_size)
  it('swaps the corners of the top face as Blockbench\'s Bedrock export does', () => {
    // up [24, 57, 19, 54] became uv [19, 54], uv_size [5, 3]: the rectangle (19, 54) to (24, 57)
    expect(fileFaceUv('up', [24, 57, 19, 54])).toEqual([19, 54, 24, 57]);
  });

  it('swaps the corners of the bottom face too', () => {
    // down [51, 33, 46, 36] became uv [46, 36], uv_size [5, -3]: from (46, 36) to (51, 33)
    expect(fileFaceUv('down', [51, 33, 46, 36])).toEqual([46, 36, 51, 33]);
  });

  it('leaves the four sides alone', () => {
    for (const direction of ['north', 'south', 'east', 'west']) {
      expect(fileFaceUv(direction, [19, 57, 24, 64])).toEqual([19, 57, 24, 64]);
    }
  });

  it('is its own inverse', () => {
    expect(fileFaceUv('up', fileFaceUv('up', [1, 2, 3, 4]))).toEqual([1, 2, 3, 4]);
  });
});
