import RAPIER from '@dimforge/rapier3d-compat';
import { buildArenaColliders } from './arena-colliders';
import { FighterBody } from './character';
import { DebrisField } from './debris';
import { PhysicsDebugDraw } from './debug-draw';
import type { PhysicsPort } from './port';
import { PropSet } from './props';
import { PhysicsWorld } from './world';

/*
  The Rapier implementation of the physics port. Loaded with a dynamic import
  from main.ts, so this module and everything it pulls in — Rapier's WASM
  included — is a separate chunk.

  Called after the stage, the arena and the rigs exist: props and debris add
  meshes to the scene, and the fighter bodies start where the rigs stand.
*/
export async function createPhysics(simHz: number): Promise<PhysicsPort> {
  await RAPIER.init();

  const pw = new PhysicsWorld(simHz);
  buildArenaColliders(pw);
  const fighters = [new FighterBody(pw, 0), new FighterBody(pw, 1)] as const;
  const props = new PropSet(pw);
  const debris = new DebrisField(pw);
  const draw = new PhysicsDebugDraw();

  /* One step before anything queries the world. Colliders enter the broad
     phase on a step, so without it the fighters' first ground probe would
     find no floor and sink a few centimetres into it. */
  pw.world.step();

  return {
    fighters,
    step: () => pw.step(),
    hold: () => pw.hold(),
    interpolate: (alpha) => {
      pw.interpolate(alpha);
      debris.present(alpha);
      draw.update(pw.world);
    },
    blast: (center, dirX, strength, radius, lift) => pw.blast(center, dirX, strength, radius, lift),
    spawnDebris: (at, dirX, count, speed, tint) => debris.spawn(at, dirX, count, speed, tint),
    resetProps: () => props.reset(),
    clearDebris: () => debris.clear(),
    setDebugDraw: (on) => draw.setEnabled(on),
    stats: () => ({ steps: pw.stepCount, dynamic: pw.dynamicCount, awake: pw.countAwake() }),
    dispose: () => {
      draw.dispose();
      debris.dispose();
      props.dispose();
      for (const f of fighters) f.dispose();
      pw.dispose();
    },
  };
}
