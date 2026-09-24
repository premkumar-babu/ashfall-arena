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
import { finishBotIntent, finishing, finishVictim, finishWinner, inFatality, paintFinish, stepFinish } from './finish';
import { blankIntent } from './intent';
import { stepState } from './fsm';
import { endRound, match, stepCombo, stepHold } from './match';
import { resolveBodyCheck, rushBotIntent, stepEmber, stepRush, stripAttacks } from './rush';
import { stepSpecials } from './specials';
import { inFatalBlow, stepFatalBlow } from './fatalblow';
import { stepThrows } from './throws';
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

  // paused, or the match intro is playing: nothing steps, and nothing pressed behind it is kept
  if (match.paused || (match.hold > 0 && stepHold(dt))) {
    physics?.hold();
    endInputStep();
    if (!match.paused) {
      // the intro shots still want the fighters posed and breathing
      poseFighter(state.P1, dt, t);
      poseFighter(state.P2, dt, t);
      driveMixer(state.P1, dt, t);
      driveMixer(state.P2, dt, t);
    }
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

  // RUSH is not played against a clock: the round ends when someone burns out.
  // FINISH THEM stops it too — the loser is already beaten.
  const fin = finishing();
  if (!match.over && !state.rush && !fin && !inFatalBlow()) {
    match.time = Math.max(0, match.time - dt);
    if (match.time === 0) {
      const lead = P1.hp === P2.hp ? null : P1.hp > P2.hp ? P1 : P2;
      endRound(lead, lead ? 'TIME UP' : 'DRAW');
    }
  }

  let i1 = controllers[0].intent();
  let i2 = versus ? controllers[1].intent() : state.rush ? rushBotIntent(P2, P1, dt) : botIntent(P2, P1, dt);
  if (fin) {
    // the loser is out on their feet; a CPU winner has its own idea of what comes next
    if (finishVictim() === P1) i1 = blankIntent();
    if (finishVictim() === P2) i2 = blankIntent();
    if (!versus && finishWinner() === P2) i2 = finishBotIntent(P2, P1);
  }
  if (inFatality() || inFatalBlow()) {
    // a cinematic is playing: nobody has the controls
    i1 = blankIntent();
    i2 = blankIntent();
  }
  // RUSH has no attacks at all: silencing the intent silences every input device and the CPU at once
  if (state.rush) { stripAttacks(i1, P1); stripAttacks(i2, P2); }
  stepKeyLegend(dt, i1.punchDown || i1.kickDown || i1.dash !== 0);

  stepState(P1, i1, dt);
  stepState(P2, i2, dt);
  // OVERDRIVE is the fatality button while someone is waiting to be finished
  stepFinish(i1, i2, dt);
  if (!state.rush && !fin) {
    stepMeter(P1, i1, P2, dt);
    stepMeter(P2, i2, P1, dt);
  }
  controllers[0].acknowledge(i1);
  if (versus) controllers[1].acknowledge(i2);
  endInputStep();

  stepCombo(P1, dt);
  stepCombo(P2, dt);

  // velocities from the game's rules, then positions from the physics world;
  // a fatality places both fighters itself
  if (inFatalBlow()) {
    stepFatalBlow(dt);                            // the fatal blow's cinematic holds both fighters where they are
  } else if (!inFatality()) {
    planMotion(P1, i1, P2, dt);
    planMotion(P2, i2, P1, dt);
    if (!state.rush) {
      stepSpecials(dt);                           // bolts fly, spears bite, a charge holds its speed
      stepFatalBlow(dt);                          // a fatal blow lunges, and connects or does not
      stepThrows(dt);                             // a throw carries its victim over the shoulder
    }
    if (state.rush) {
      // per-character movement kits, then body-to-body checks, before anything is moved
      stepRush(P1, i1, dt);
      stepRush(P2, i2, dt);
      resolveBodyCheck(P1, P2, dt);
    }
    resolveMotion(P1, P2, dt);
  }
  if (physics) physics.step();
  if (state.rush) stepEmber(dt);                   // tag on the positions this step ended at, then burn

  if (!state.rush) {
    stepAssist(P1.assist, P2, dt, t);
    stepAssist(P2.assist, P1, dt, t);
  }

  poseFighter(P1, dt, t);
  poseFighter(P2, dt, t);
  driveMixer(P1, dt, t);
  driveMixer(P2, dt, t);
  paintFinish();
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
        // the fighters sharp, the stage behind them soft: range is how deep the sharp band runs
        post?.setFocus(camera.position.distanceTo(_focus.set(rigState.mid, 1.7, PLANE_Z)), 9, 1.5);
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
