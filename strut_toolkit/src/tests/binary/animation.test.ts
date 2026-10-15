import { encodeAnimation, decodeAnimation, fingerprintText, RawBinaryAnimation } from '../../ts/binary/animation';

/**
 * Every value/time field in the wire format is an IEEE754 float32 - `f` pre-rounds a fixture's
 * double-precision literal (e.g. `0.1`) to its nearest float32 value, matching what
 * {@link BinaryWriter#f32}/{@link BinaryReader#f32} would do to it anyway. Without this, a
 * strict `toEqual` against the untruncated literal fails not because the codec is wrong but
 * because `0.1` was never representable exactly in the first place - the same float32 precision
 * trap `BinaryAnimationBakerTest`'s `assertArgs` helper works around on the Java side, here
 * avoided by testing against an already-truncated fixture instead of an epsilon comparison
 */
const f = Math.fround;

/**
 * The particle event payload uses the ASCII unit separator (U+001F) between its three fields -
 * written as an explicit `` escape here rather than a raw embedded control character. A
 * raw control byte in a source file is exactly the trap this session hit twice already (a
 * corrupted NUL in BakedGeoModel.java, and this very literal silently losing its separators on
 * an earlier write of this file) - both looked like ordinary text in a transcript and were not
 */
const PARTICLE_PAYLOAD = 'effectlocatorscript';

/**
 * A synthetic clip exercising every keyframe shape the format allows: a linear anchor, a step
 * keyframe with a separate outgoing value, a catmull-rom keyframe with a named easing and an
 * argument, a bezier keyframe with its four handles, a Molang expression component, and one of
 * each event kind
 */
function syntheticAnimation(): RawBinaryAnimation {
    return {
        version: 100,
        flags: 0,
        skeletonFingerprint: -200221733, // 0xF410DBDB, the real rig_demo skeleton's fingerprint
        strings: [
            'walk', 'upper', 'easeinoutelastic', 'math.sin(query.anim_time * 30)',
            'sound', 'strut:test.step',
            'particle', PARTICLE_PAYLOAD,
            'instruction', 'say hi',
        ],
        clips: [
            {
                name: 'walk',
                duration: 1,
                loop: 'LOOP',
                channels: [
                    {
                        target: 'upper',
                        targetKind: 'ARMATURE_BONE',
                        property: 'ROTATION',
                        interpolation: null, // mixed - each keyframe below declares its own
                        keys: [
                            {
                                time: 0,
                                interpolation: 'LINEAR',
                                value: { literals: [0, 0, 0], expressions: [null, null, null] },
                                post: null,
                                easing: null,
                                easingArgs: [],
                                bezier: null,
                            },
                            {
                                time: 0.25,
                                interpolation: 'STEP',
                                value: { literals: [10, 0, 0], expressions: [null, null, null] },
                                post: { literals: [20, 0, 0], expressions: [null, null, null] },
                                easing: null,
                                easingArgs: [],
                                bezier: null,
                            },
                            {
                                time: 0.5,
                                interpolation: 'CATMULLROM',
                                value: { literals: [30, 0, 0], expressions: [null, 'math.sin(query.anim_time * 30)', null] },
                                post: null,
                                easing: 'easeinoutelastic',
                                easingArgs: [1.5],
                                bezier: null,
                            },
                            {
                                time: 0.75,
                                interpolation: 'BEZIER',
                                value: { literals: [40, 0, 0], expressions: [null, null, null] },
                                post: null,
                                easing: null,
                                easingArgs: [],
                                bezier: {
                                    leftTime: [f(-0.1), f(-0.1), f(-0.1)],
                                    leftValue: [-1, -1, -1],
                                    rightTime: [f(0.1), f(0.1), f(0.1)],
                                    rightValue: [1, 1, 1],
                                },
                            },
                        ],
                    },
                ],
                events: [
                    { time: f(0.1), kind: 'sound', payload: 'strut:test.step', authority: 0 },
                    { time: f(0.2), kind: 'particle', payload: PARTICLE_PAYLOAD, authority: 1 },
                    { time: f(0.3), kind: 'instruction', payload: 'say hi', authority: 0 },
                ],
            },
        ],
    };
}

describe('encodeAnimation / decodeAnimation round trip', () => {
  it('write -> read -> write is byte-identical for a synthetic clip exercising every keyframe shape', () => {
    const animation = syntheticAnimation();
    const firstBytes = encodeAnimation(animation);
    const decoded = decodeAnimation(firstBytes, 'synthetic.strutanim');
    const secondBytes = encodeAnimation(decoded);

    expect(Array.from(secondBytes)).toEqual(Array.from(firstBytes));
  });

  it('decoding preserves every field of the synthetic animation', () => {
    const animation = syntheticAnimation();
    const decoded = decodeAnimation(encodeAnimation(animation), 'synthetic.strutanim');

    expect(decoded).toEqual(animation);
  });

  it('preserves the bezier handles exactly', () => {
    const animation = syntheticAnimation();
    const decoded = decodeAnimation(encodeAnimation(animation), 'synthetic.strutanim');
    const bezierKey = decoded.clips[0].channels[0].keys[3];

    expect(bezierKey.interpolation).toEqual('BEZIER');
    expect(bezierKey.bezier).toEqual({
      leftTime: [f(-0.1), f(-0.1), f(-0.1)],
      leftValue: [-1, -1, -1],
      rightTime: [f(0.1), f(0.1), f(0.1)],
      rightValue: [1, 1, 1],
    });
  });

  it('preserves the skeleton fingerprint as a signed 32-bit value', () => {
    const animation = syntheticAnimation();
    const decoded = decodeAnimation(encodeAnimation(animation), 'synthetic.strutanim');

    expect(decoded.skeletonFingerprint).toEqual(-200221733);
    expect(fingerprintText(decoded.skeletonFingerprint)).toEqual('0xf410dbdb');
  });

  it('preserves a Molang expression component distinct from a literal one', () => {
    const animation = syntheticAnimation();
    const decoded = decodeAnimation(encodeAnimation(animation), 'synthetic.strutanim');
    const catmullromKey = decoded.clips[0].channels[0].keys[2];

    expect(catmullromKey.value.expressions[1]).toEqual('math.sin(query.anim_time * 30)');
    expect(catmullromKey.value.literals[0]).toEqual(30);
  });

  it('preserves the particle payload and its unit-separator-delimited fields', () => {
    const animation = syntheticAnimation();
    const decoded = decodeAnimation(encodeAnimation(animation), 'synthetic.strutanim');
    const particleEvent = decoded.clips[0].events[1];

    expect(particleEvent.payload).toEqual(PARTICLE_PAYLOAD);
    expect(particleEvent.payload.split('')).toEqual(['effect', 'locator', 'script']);
  });

  it('rejects a file that does not begin with the STAM magic', () => {
    expect(() => decodeAnimation(new Uint8Array(32), 'bad.strutanim')).toThrow(/not a Strut binary animation/);
  });

  it('rejects a keyframe interpolation that contradicts its channel', () => {
    const animation = syntheticAnimation();
    const withMismatch: RawBinaryAnimation = {
      ...animation,
      clips: [{
        ...animation.clips[0],
        channels: [{
          ...animation.clips[0].channels[0],
          interpolation: 'LINEAR', // declares one mode for every keyframe...
          keys: animation.clips[0].channels[0].keys, // ...but they aren't all LINEAR
        }],
      }],
    };

    expect(() => decodeAnimation(encodeAnimation(withMismatch), 'bad.strutanim')).toThrow(/mixed sentinel/);
  });
});
