/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Copying and pasting armatures in Blockbench 5.x.
 *
 * Copy a group that contains an armature, paste it, and the armature comes back as a plain group: every bone and the mesh turn into default cubes (or
 * vanish). Copying the armature itself works; copying a group around it does not.
 *
 * Why: {@code Group.getSaveCopy(true)} saves a nested armature with {@code Armature.getSaveCopy()}, which lists its children as bare uuid strings and
 * carries none of their data. {@code Clipbench.pasteOutliner} then sees an object with a "children" array, treats it as a Group, and treats each uuid string
 * as an element with no type, which Blockbench builds as a Cube.
 *
 * A second form of the same bug: copy the armature itself (it and its bones selected) and paste it into a group or at the top level, and the bones are
 * dropped, because paste only lets an element in where its own type is allowed, and a bone is not allowed in a group.
 *
 * What this does: an armature is saved with its whole content (bones, mesh and null objects, with their hierarchy) under "paste_content", and without a
 * "children" list, so paste builds it as an Armature again, whether it was copied inside a group or by itself. Right after, before the paste's undo step is
 * closed, the bones and meshes are rebuilt under the new armature, so one Undo takes the whole paste back. Pasting an armature while an armature or a bone
 * is selected puts the copy at the top level (it used to do nothing). Nothing else about copy and paste changes.
 */

interface Originals {
  getSaveCopy: any;
  extend: any;
  pasteOutliner: any;
  setElements: any;
}

let originals: Originals | null = null;

/** The armature and everything under it, as saves with their children as uuid lists */
function armatureSave(armature: any): any {
  const save = armature.getSaveCopy();
  const content: any[] = [];

  armature.forEachChild((child: any) => content.push(child.getSaveCopy()));

  save.paste_children = save.children;
  save.paste_content = content;
  delete save.children;

  return save;
}

/** Whether what is on the clipboard (or was copied last) holds an armature */
function clipboardHasArmature(): boolean {
  let elements: any = (globalThis as any).Clipbench.elements;

  try {
    // Blockbench's own require (the app's), not a module for the bundler to resolve
    const appRequire = (globalThis as any).require;

    if (isApp && typeof appRequire === 'function') {
      const data = JSON.parse(appRequire('electron').clipboard.readHTML());

      if (data.type === 'elements' && data.content)
        elements = data.content;
    }
  }
  catch (error) {
    // Not our data: use what was copied inside Blockbench
  }

  return Array.isArray(elements) && elements.some((e: any) => e && e.type === 'armature');
}

/**
 * A bone keeps its vertex weights under "<first 6 characters of the mesh's uuid>:<vertex key>", and a pasted mesh has a new uuid, so every weight would point
 * at a mesh that is not there. Blockbench's own Duplicate remaps them; paste has to as well.
 */
function remapVertexWeights(content: any[], copies: Record<string, any>): void {
  const meshes: Record<string, any> = {};

  for (const save of content)
    if (save.type === 'mesh' && copies[save.uuid])
      meshes[save.uuid.substring(0, 6)] = copies[save.uuid];

  for (const save of content) {
    const bone = copies[save.uuid];

    if (save.type !== 'armature_bone' || !bone)
      continue;

    const old = Object.assign({}, save.vertex_weights || {});

    bone.vertex_weights = {};

    for (const key of Object.keys(old)) {
      const [prefix, vkey] = key.split(':');
      const mesh = vkey === undefined ? null : meshes[prefix];

      if (mesh)
        bone.setVertexWeight(mesh, vkey, old[key]);
      else
        bone.vertex_weights[key] = old[key];
    }
  }
}

/** Builds the content of every armature that a paste just made, under it, with the old hierarchy */
function restoreArmatures(): void {
  const ArmatureType = (globalThis as any).Armature;
  const pasted = Outliner.elements.filter((e: any) => e instanceof ArmatureType && e.__paste_armature);
  const all: any[] = [];

  for (const armature of pasted as any[]) {
    const info = armature.__paste_armature;
    const copies: Record<string, any> = {};

    delete armature.__paste_armature;

    for (const save of info.content) {
      const Type = (OutlinerElement as any).types[save.type];

      if (!Type)
        continue;

      const copy = new Type(save);

      copy.init();
      copies[save.uuid] = copy;
    }

    for (const uuid of info.children)
      if (copies[uuid]) copies[uuid].addTo(armature);

    for (const save of info.content)
      for (const uuid of save.children || [])
        if (copies[uuid] && copies[save.uuid]) copies[uuid].addTo(copies[save.uuid]);

    remapVertexWeights(info.content, copies);

    for (const copy of Object.values(copies)) {
      copy.createUniqueName();
      Property.resetUniqueValues(copy.constructor, copy);
      copy.markAsSelected();
      all.push(copy);
    }
  }

  if (all.length > 0)
    Canvas.updateView({ elements: all, element_aspects: { geometry: true, transform: true } } as any);
}

export function loadArmaturePasteFix(): void {
  const g = globalThis as any;

  // Blockbench without armatures (older than 5.0) has nothing to fix
  if (originals !== null || !g.Armature || !g.ArmatureBone)
    return;

  const clipbench = (globalThis as any).Clipbench;
  const found: Originals = {
    getSaveCopy: g.Group.prototype.getSaveCopy,
    extend: g.Armature.prototype.extend,
    pasteOutliner: clipbench.pasteOutliner,
    setElements: clipbench.setElements,
  };

  originals = found;

  // Copy: a nested armature carries its content
  g.Group.prototype.getSaveCopy = function (this: any, nested: boolean) {
    const base = this.getChildlessCopy(true);

    if (nested) {
      for (const child of this.children)
        base.children.push(child instanceof g.Armature ? armatureSave(child) : child.getSaveCopy(nested));
    }

    delete base.parent;

    return base;
  };

  // Copy: an armature copied by itself carries its content too, and its bones are not saved a second time
  clipbench.setElements = function (arr: any[]) {
    if (!arr) {
      clipbench.elements = [];

      return;
    }

    const inside = new Set<any>();

    arr.filter(e => e instanceof g.Armature).forEach(armature => armature.forEachChild((child: any) => inside.add(child)));

    for (const element of arr) {
      if (inside.has(element) || element.getTypeBehavior('duplicatable') == false)
        continue;

      clipbench.elements.push(element instanceof g.Armature ? armatureSave(element) : element.getSaveCopy());
    }

    // Blockbench's own version, given nothing new to add, writes what is in Clipbench.elements to the system clipboard
    found.setElements.call(clipbench, []);
  };

  // Paste: the armature remembers the content it was saved with
  g.Armature.prototype.extend = function (this: any, object: any) {
    if (object && object.paste_content)
      this.__paste_armature = { content: object.paste_content, children: object.paste_children || [] };

    return found.extend.call(this, object);
  };

  // Paste: the content is rebuilt inside the same undo step
  clipbench.pasteOutliner = function (this: any, event: any) {
    const finish = Undo.finishEdit;

    // An armature cannot go inside an armature or a bone, so it is pasted at the top level instead of being skipped
    const first = Outliner.selected[0];

    if (!g.Group.first_selected && (first instanceof g.Armature || first instanceof g.ArmatureBone) && clipboardHasArmature())
      Outliner.selected.length = 0;

    Undo.finishEdit = function (this: any, ...args: any[]) {
      Undo.finishEdit = finish;

      try {
        restoreArmatures();
      }
      catch (error) {
        console.error('Strut: restoring pasted armatures failed:', error);
      }

      return (finish as any).apply(this, args);
    } as any;

    try {
      return found.pasteOutliner.call(this, event);
    }
    finally {
      Undo.finishEdit = finish;
    }
  };
}

export function unloadArmaturePasteFix(): void {
  if (originals === null)
    return;

  const g = globalThis as any;
  const clipbench = (globalThis as any).Clipbench;

  g.Group.prototype.getSaveCopy = originals.getSaveCopy;
  g.Armature.prototype.extend = originals.extend;
  clipbench.pasteOutliner = originals.pasteOutliner;
  clipbench.setElements = originals.setElements;
  originals = null;
}
