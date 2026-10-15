import { easingFunctions } from '../ts/easing';

/**
 * Mirrors the names registered in
 * src/main/java/com/sandymandy/strut/animation/EasingType.java, lowercased - the wire format
 * (both `.animation.json` and `.strutanim`) carries a named easing as a lowercase string, and
 * EasingType.fromString looks it up case-sensitively against exactly this set. Two registries
 * (this plugin's easingFunctions, the Java engine's EasingType) implement the same easing list
 * independently; nothing else keeps them from drifting apart except this test.
 * <p>
 * `catmullrom` and `bezier` are deliberately absent here - they aren't named easings a user picks
 * from this plugin's dropdown, they're keyframe interpolation modes with their own dedicated
 * handling (see keyframe.ts's compileBedrockKeyframe and the "strut_bezier" sentinel). `none` is
 * an alias Java registers for `linear` and has no separate entry on the plugin side either.
 * <p>
 * If this test fails after adding an easing to EasingType.java, add the matching entry to
 * easingFunctions in easing.ts (or vice versa) rather than editing this list to match - the list
 * is meant to catch exactly that drift.
 */
const JAVA_REGISTERED_EASING_NAMES = new Set([
  'linear', 'none', 'step',
  'easeinsine', 'easeoutsine', 'easeinoutsine',
  'easeinquad', 'easeoutquad', 'easeinoutquad',
  'easeincubic', 'easeoutcubic', 'easeinoutcubic',
  'easeinquart', 'easeoutquart', 'easeinoutquart',
  'easeinquint', 'easeoutquint', 'easeinoutquint',
  'easeinexpo', 'easeoutexpo', 'easeinoutexpo',
  'easeincirc', 'easeoutcirc', 'easeinoutcirc',
  'easeinback', 'easeoutback', 'easeinoutback',
  'easeinelastic', 'easeoutelastic', 'easeinoutelastic',
  'easeinbounce', 'easeoutbounce', 'easeinoutbounce',
  'catmullrom', 'bezier',
]);

describe('easing registry parity with EasingType.java', () => {
  it('every plugin easing name, lowercased, is registered on the Java side', () => {
    const missing = Object.keys(easingFunctions)
      .map(name => name.toLowerCase())
      .filter(name => !JAVA_REGISTERED_EASING_NAMES.has(name));

    expect(missing).toEqual([]);
  });
});
