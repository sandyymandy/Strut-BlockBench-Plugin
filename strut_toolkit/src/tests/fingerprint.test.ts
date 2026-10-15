import { javaStringHashCode, skeletonFingerprint } from '../ts/binary/fingerprint';

describe('javaStringHashCode', () => {
  it('matches java.lang.String.hashCode() for an empty string', () => {
    expect(javaStringHashCode('')).toEqual(0);
  });

  it('matches java.lang.String.hashCode() for an ASCII string', () => {
    // Verified with a real `javac`/`java` run: "hello".hashCode() == 99162322
    expect(javaStringHashCode('hello')).toEqual(99162322);
  });

  it('reproduces 32-bit signed overflow the way Java does', () => {
    // A string long/varied enough that naive double arithmetic diverges from Java's 32-bit
    // int overflow well before this point; verified with a real `javac`/`java` run
    expect(javaStringHashCode('root lower upper the quick brown fox jumps')).toEqual(1566567053);
  });
});

describe('skeletonFingerprint', () => {
  it('matches BakedGeoModel.skeletonFingerprint() for the shipped rig_demo skeleton', () => {
    // The real, live-verified value (see docs/BINARY_CODEC_PLAN.md §2 and the commit that fixed
    // a raw NUL byte corrupted into BakedGeoModel.java's source): the Java method is NUL-
    // separated, not space-separated, confirmed by running it against the committed
    // rig_demo.strutmodel/.strutanim pair rather than by re-reading the source
    expect(skeletonFingerprint(['root'], [['lower', 'upper']])).toEqual(0xF410DBDB | 0);
  });

  it('is order-sensitive: swapping bone order changes the fingerprint', () => {
    const forward = skeletonFingerprint(['root'], [['lower', 'upper']]);
    const swapped = skeletonFingerprint(['root'], [['upper', 'lower']]);

    expect(forward).not.toEqual(swapped);
  });

  it('is a no-op for a skeleton with no bones at all', () => {
    expect(skeletonFingerprint([], [])).toEqual(javaStringHashCode(''));
  });
});
