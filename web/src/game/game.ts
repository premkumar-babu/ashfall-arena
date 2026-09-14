import { driveAssistMixer, driveMixer } from '../anim/animation';
import * as THREE from 'three/webgpu';
import {
  flushCamTween, rigState, updateCameraFight, updateCameraSelect, updateCameraTitle, updateCamTweens,
} from '../camera/camera-rig';
import { PHASE, PLANE_Z } from '../config/constants';
import { Governor } from '../core/frame-governor';
import { presentScale, updateFeel } from '../fx/juice';
import { updateStrikeLights } from '../fx/strike-lights';
import { controllers, endInputStep, input, pollDevices } from '../input/controller';
import { physics } from '../physics/port';
import { post } from '../render/post';
import { camera } from '../render/stage';
import { refreshPads } from '../ui/front-end';
import { stepKeyLegend, syncHud } from '../ui/hud';
import { stepPadMenu } from '../ui/pad-menu';
import { updateAmbience } from '../world/ambience';
import { stepAssist } from './assist';
import { botIntent } from './bot';
import { resolveAssist, resolveCombat, settleKO, syncAssistBoxes, syncBoxes } from './collision';
import { stepState } from './fsm';
import { endRound, match, stepCombo } from './match';
import { stepMeter } from './meter';
import { planMotion, resolveMotion } from './movement';
import { poseFighter, stageSelectPreview } from './pose';
import { state } from './state';

/*
  The two halves of a frame.

  simulate() is one fixed step and is the only place match state changes:
  input, the bot, the state machines, meter, movement and the physics world,
  assists, and collision. Posing and the animation mixers run here too,
  because every hitbox and hurtbox hangs off the posed rig.

  present() runs once per displayed frame on real time and only reads state:
  the camera, physics meshes (interpolated), particles, the HUD and the draw.
*/

export function simulate(dt: number): void {
  state.elapsed += dt;
  const t = state.elapsed;

  pollDevices();
  stepPadMenu();                                   // title, select, pause and results answer a gamepad

  if (state.phase !== PHASE.FIGHT) {
    if (state.phase === PHASE.SELECT) {
      stageSelectPreview(dt, t);
      refreshPads();
    }
    physics?.hold();
    endInputStep();
    return;
  }

  // paused: nothing steps, and nothing pressed behind the pause card is kept
  if (match.paused) {
    physics?.hold();
    endInputStep();
    return;
  }

  const { P1, P2 } = state;
  const versus = !state.mode1P;
  const frozen = match.freeze > 0;

  // captured even during hit-stop, so a press made in the freeze is buffered for when it lifts
  controllers[0].capture(P1, dt, frozen);
  if (versus) controllers[1].capture(P2, dt, frozen);

  if (frozen) {
    match.freeze -= dt;
    physics?.hold();
    endInputStep();
    return;
  }

  if (!match.over) {
    match.time = Math.max(0, match.time - dt);
    if (match.time === 0) {
      const lead = P1.hp === P2.hp ? null : P1.hp > P2.hp ? P1 : P2;
      endRound(lead, lead ? 'TIME UP' : 'DRAW');
    }
  }

  const i1 = controllers[0].intent();
  const i2 = versus ? controllers[1].intent() : botIntent(P2, P1, dt);
  stepKeyLegend(dt, i1.punchDown || i1.kickDown || i1.dash !== 0);

  stepState(P1, i1, dt);
  stepState(P2, i2, dt);
  stepMeter(P1, i1, P2, dt);
  stepMeter(P2, i2, P1, dt);
  controllers[0].acknowledge(i1);
  if (versus) controllers[1].acknowledge(i2);
  endInputStep();

  stepCombo(P1, dt);
  stepCombo(P2, dt);

  // velocities from the game's rules, then positions from the physics world
  planMotion(P1, i1, P2, dt);
  planMotion(P2, i2, P1, dt);
  resolveMotion(P1, P2, dt);
  if (physics) physics.step();

  stepAssist(P1.assist, P2, dt, t);
  stepAssist(P2.assist, P1, dt, t);

  poseFighter(P1, dt, t);
  poseFighter(P2, dt, t);
  driveMixer(P1, dt, t);
  driveMixer(P2, dt, t);
  driveAssistMixer(P1.assist, dt);
  driveAssistMixer(P2.assist, dt);

  syncBoxes(P1);
  syncBoxes(P2);
  syncAssistBoxes(P1.assist);
  syncAssistBoxes(P2.assist);
  updateStrikeLights(dt);
  resolveCombat(P1, P2);
  resolveCombat(P2, P1);
  resolveAssist(P1.assist, P2);
  resolveAssist(P2.assist, P1);
  settleKO();
}

const _focus = new THREE.Vector3();

/* Depth of field focus per phase: the fighters stay sharp, the far courtyard
   and skyline soften. The select screen's close portrait framing gets a
   shallower field, which is what makes it read as a character shot. */
export function present(alpha: number, frameDt: number): void {
  const t = state.elapsed;
  physics?.interpolate(alpha);
  input.touch?.sync(state.phase === PHASE.FIGHT && !match.paused && !document.body.classList.contains('results'));
  updateFeel(frameDt);                             // decays shake and lens kicks, drives listener, clock ticks and music

  switch (state.phase) {
    case PHASE.TITLE:
      updateCameraTitle(frameDt, t);
      post?.setFocus(12, 26, 0.8);
      updateAmbience(frameDt, t);
      if (Governor.draw) post?.render(t);
      return;

    case PHASE.SELECT:
      updateCamTweens();
      updateCameraSelect(frameDt);
      post?.setFocus(camera.position.distanceTo(_focus.set(0, 1.9, 0.2)), 7, 1.6);
      updateAmbience(frameDt, t);
      if (Governor.draw) post?.render(t);
      // started last, so the clock begins after whatever this phase's first frame cost
      flushCamTween();
      return;

    case PHASE.FIGHT:
      // paused: keep the frozen frame on screen and nothing else
      if (!match.paused) {
        updateCameraFight(frameDt);             // shake keeps running through hit-stop
        post?.setFocus(camera.position.distanceTo(_focus.set(rigState.mid, 1.7, PLANE_Z)), 28, 1.1);
        if (match.freeze <= 0) {
          // particles and drifting motes slow down with a KO's slow motion
          updateAmbience(frameDt * presentScale(), t);
          syncHud(frameDt);
        }
      }
      if (Governor.draw) post?.render(t);
      return;
  }
}
