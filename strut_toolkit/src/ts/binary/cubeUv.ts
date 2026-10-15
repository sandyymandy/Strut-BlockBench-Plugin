/**
 * A cube face's UV rotation, in 90-degree steps, wrapped into [0, 4)
 * <p>
 * Pulled out of `strutCodec.ts` into its own dependency-free module specifically so it is unit
 * testable without a live Blockbench face object - `strutCodec.ts` eagerly imports `./codec`,
 * which touches several Blockbench globals at module scope, the same trap
 * `docs/BINARY_CODEC_PLAN.md` §4 and fork phase 5 stage 5's `legacyMigration.ts` both hit
 */
export function cubeFaceUvRotationSteps(degrees: number): number {
    return Math.floor((degrees || 0) / 90) % 4;
}

/**
 * A face's UV rectangle as the file keeps it, from Blockbench's own, and back (the swap is its own inverse)
 * <p>
 * The file keeps a face the way a Bedrock geometry file does, which the game's cube baker reads. Blockbench keeps the top and bottom faces turned half a turn from
 * that: its top face of a plain cube is [u + sz + sx, v + sz, u + sz, v], a Bedrock one is [u + sz, v, u + sz + sx, v + sz]. Blockbench's own Bedrock export swaps the
 * rectangle's two corners for exactly those two faces (checked against a real model and the geometry file Blockbench wrote for it), so this does the same. Written
 * as it is in Blockbench, the top and bottom faces of every cube were drawn turned half a turn in the game
 */
export function fileFaceUv(direction: string, uv: readonly number[]): [number, number, number, number] {
    const [u1, v1, u2, v2] = uv;

    return direction === 'up' || direction === 'down' ? [u2, v2, u1, v1] : [u1, v1, u2, v2];
}

/**
 * Whether a cube face should be written to the wire format at all
 * <p>
 * `texture === null` is Blockbench's own marker for a face that is genuinely absent - the "Blank"
 * option in the face's texture menu - and it is what its own renderer (`if (face.texture === null)
 * continue`) and its own geometry compiler (`if (s.faces[face].texture !== null) { ...emit... }`)
 * both gate on, verified against real 5.1.6 source. `enabled === false` is a weaker, separate
 * flag, for which Blockbench's compiler only suppresses that face's *UV*, not the face itself -
 * both are treated as absent here, since neither is meant to be drawn
 * <p>
 * The strict `=== null` matters. A falsy `texture` is not the same thing: on a
 * `single_texture: true` project (Strut's format is one), a face's own `texture` is legitimately
 * `false` for every ordinary, fully-present face, since per-face texture assignment does not exist
 * in that mode at all. Live-verified: a former `if (!texture) continue` in the exporter dropped
 * every cube face on every Strut project, leaving every exported cube with zero faces - invisible,
 * not just wrongly-shaded. Blockbench draws the same `false`/`null` distinction itself, in
 * `Cube#applyTexture`
 */
export function isCubeFaceExported(face: { texture?: unknown; enabled?: unknown }): boolean {
    return face.texture !== null && face.enabled !== false;
}
