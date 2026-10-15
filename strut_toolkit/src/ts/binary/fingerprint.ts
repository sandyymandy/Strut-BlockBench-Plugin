/**
 * A TypeScript port of {@code java.lang.String.hashCode()} and
 * {@code BakedGeoModel.skeletonFingerprint()}, so the plugin can write the exact fingerprint the
 * Java engine will independently recompute from the same skeleton
 * <p>
 * See {@code docs/BINARY_CODEC_PLAN.md} §2: Java's {@code String.hashCode()} is
 * {@code 31*h + c} with **32-bit signed overflow** - `h = 31*h + c` on JS doubles works until it
 * silently stops matching, since JS numbers do not overflow the way a 32-bit `int` does. Every
 * multiply-and-add here goes through {@link Math.imul} and is corrected with `| 0` to reproduce
 * that overflow exactly
 */

/**
 * The TypeScript equivalent of {@code String.hashCode()} - documented as part of the JDK's
 * contract (`s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]`), computed here the same iterative way
 * `java.lang.String` computes it: `h = 31*h + charCode`, at 32-bit signed precision throughout
 */
export function javaStringHashCode(value: string): number {
    let hash = 0;

    for (let i = 0; i < value.length; i++) {
        hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
    }

    return hash;
}

/**
 * Mirrors {@code BakedGeoModel.skeletonFingerprint()} exactly: every group bone's name (in
 * parent-before-child order), then every armature's bones' names (in each armature's own order),
 * each followed by a **NUL character** (`\0`), concatenated and hashed as one string
 * <p>
 * The Java source's own separator is a raw embedded NUL byte rather than a visible character - it
 * displays as an ordinary space in most editors and tooling (including the tool this plugin was
 * ported with), which is how a `' '`-separated assumption here would have gone undetected: it
 * compiles, it runs, and it is wrong. Confirmed against the real shipped
 * `rig_demo.strutmodel`/`.strutanim` pair, whose committed fingerprint (`0xF410DBDB`) only matches
 * `"root\0lower\0upper\0"`, not `"root lower upper "` - verified by running the actual Java method
 * against that asset, not by re-reading the source
 * <p>
 * Bone order is part of the hash - the exporter must walk bones in the same parent-before-child
 * order the Java bake's {@code flatBones()} produces, or a correctly-shaped skeleton still
 * fingerprints differently and every boot logs a spurious mismatch warning
 *
 * @param groupBoneNames Group bone names, parent-before-child
 * @param armatureBoneNames One array per armature, each in that armature's own bone order
 */
export function skeletonFingerprint(groupBoneNames: string[], armatureBoneNames: string[][]): number {
    let names = '';

    for (const name of groupBoneNames) {
        names += name + '\0';
    }

    for (const armature of armatureBoneNames) {
        for (const name of armature) {
            names += name + '\0';
        }
    }

    return javaStringHashCode(names);
}
