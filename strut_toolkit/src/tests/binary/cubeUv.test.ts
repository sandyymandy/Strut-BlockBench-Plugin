import { cubeFaceUvRotationSteps, isCubeFaceExported } from '../../ts/binary/cubeUv';

/**
 * strutCodec.ts itself can't be imported directly in a jest test - it eagerly imports ./codec,
 * which touches Blockbench globals at module scope - so this pure helper lives in its own
 * dependency-free module instead (see ts/binary/cubeUv.ts's own doc comment)
 */
describe('cubeFaceUvRotationSteps', () => {
  it('converts a degree rotation into 90-degree steps', () => {
    expect(cubeFaceUvRotationSteps(0)).toEqual(0);
    expect(cubeFaceUvRotationSteps(90)).toEqual(1);
    expect(cubeFaceUvRotationSteps(180)).toEqual(2);
    expect(cubeFaceUvRotationSteps(270)).toEqual(3);
  });

  it('wraps a full rotation back to 0', () => {
    expect(cubeFaceUvRotationSteps(360)).toEqual(0);
    expect(cubeFaceUvRotationSteps(450)).toEqual(1);
  });

  it('treats undefined/falsy rotation as 0', () => {
    expect(cubeFaceUvRotationSteps(undefined as unknown as number)).toEqual(0);
    expect(cubeFaceUvRotationSteps(0)).toEqual(0);
  });
});

describe('isCubeFaceExported', () => {
  it('drops a blanked face, which Blockbench marks with texture === null', () => {
    expect(isCubeFaceExported({ texture: null })).toBe(false);
  });

  it('drops a face explicitly disabled', () => {
    expect(isCubeFaceExported({ texture: 'some-uuid', enabled: false })).toBe(false);
  });

  /**
   * The case the strict null check exists for: on a single_texture project every ordinary,
   * fully-present face carries texture === false, and gating on falsiness dropped every cube
   * face on every Strut project
   */
  it('keeps an ordinary single_texture face, whose texture is false rather than null', () => {
    expect(isCubeFaceExported({ texture: false })).toBe(true);
    expect(isCubeFaceExported({ texture: false, enabled: true })).toBe(true);
  });

  it('keeps a face with a texture assigned, and one that declares neither field', () => {
    expect(isCubeFaceExported({ texture: 'some-uuid' })).toBe(true);
    expect(isCubeFaceExported({})).toBe(true);
    expect(isCubeFaceExported({ texture: undefined })).toBe(true);
  });
});
