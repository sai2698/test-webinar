/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  MEDIA VISIBILITY POLICY — the single most important file.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Hiding a tile in the UI is NOT a privacy guarantee. The SFU must never
 * create a Consumer that would deliver a producer's media to a peer who is
 * not allowed to receive it. Every consume path funnels through
 * `canConsume()` below, and the server re-checks it on every request.
 *
 * Rules
 * ─────
 *  ADMIN      → sees and hears everyone.
 *  HOST       → sees and hears everyone.
 *  MODERATOR  → sees and hears everyone.
 *  PARTICIPANT→ sees/hears HOST, MODERATOR and ADMIN only.
 *               Additionally hears (audio only) the currently approved
 *               participant speaker — never their video.
 *
 * The one thing that changes those rules is the webinar's
 * `showParticipantsToEachOther` setting. When the host turns it on the room
 * behaves like a meeting: participants see and hear each other in full. It is
 * off by default because a webinar is a broadcast — an attendee joining a
 * product demo does not expect their camera in every other attendee's grid.
 */

import type { Role, MediaSource } from '@webinar/shared';

export interface VisibilitySubject {
  role: Role;
  isApprovedSpeaker: boolean;
}

export interface VisibilityObject extends VisibilitySubject {
  kind: 'audio' | 'video';
  source?: MediaSource;
}

/**
 * The room-level part of the policy.
 *
 * Passed in rather than read from a global so the decision stays a pure
 * function of its inputs — every call site already has the Room in hand, and a
 * pure function is the only kind that can be reasoned about when the question
 * is "who can see whom".
 */
export interface VisibilityPolicy {
  /** The webinar's `showParticipantsToEachOther` setting. */
  participantsSeeEachOther: boolean;
}

const STAFF: Role[] = ['ADMIN', 'HOST', 'MODERATOR'];

export function isStaffRole(role: Role): boolean {
  return STAFF.includes(role);
}

/**
 * @param viewer        the peer who wants to receive media
 * @param producerOwner the peer who published the producer
 * @param policy        room-level switches, i.e. `showParticipantsToEachOther`
 */
export function canConsume(
  viewer: VisibilitySubject,
  producerOwner: VisibilityObject,
  policy: VisibilityPolicy
): boolean {
  // Staff see and hear everything.
  if (isStaffRole(viewer.role)) return true;

  // Participants always receive staff media.
  if (isStaffRole(producerOwner.role)) return true;

  // The host has opened the room up. Everyone is mutually visible, which is
  // the whole point of the setting — no per-source carve-outs, because a
  // participant who can see another participant's camera but not their screen
  // share would be a confusing half-measure.
  if (policy.participantsSeeEachOther) return true;

  // A screen share is a presentation — it is meant to be seen by the room.
  // Only approved speakers may publish one, so this stays tightly scoped.
  if (producerOwner.kind === 'video' && producerOwner.source === 'screen') {
    return producerOwner.isApprovedSpeaker;
  }

  // Participants never receive other participants' camera video.
  if (producerOwner.kind === 'video') return false;

  // Participants hear only the currently approved speaker's audio.
  return producerOwner.isApprovedSpeaker;
}

/**
 * Whether `viewer` should be told that `target` exists at all.
 *
 * Separate from `canConsume` because a peer can be worth listing without
 * having any media yet — the roster shows people who have not turned a camera
 * on. The two must agree, though: a peer whose media is invisible must not
 * appear as an empty tile, or the audience sees a grid of strangers' names.
 */
export function canSeePeer(
  viewer: VisibilitySubject,
  target: VisibilitySubject,
  policy: VisibilityPolicy
): boolean {
  if (isStaffRole(viewer.role)) return true;
  if (isStaffRole(target.role)) return true;
  if (policy.participantsSeeEachOther) return true;
  return target.isApprovedSpeaker;
}

/**
 * Whether a peer is allowed to publish at all.
 * Staff always may. Participants only when the webinar allows it AND a
 * moderator has approved their raised hand.
 */
export function canPublish(
  peer: VisibilitySubject,
  settings: { allowMic: boolean; allowVideo: boolean },
  kind: 'audio' | 'video'
): boolean {
  if (isStaffRole(peer.role)) return true;
  if (!peer.isApprovedSpeaker) return false;
  return kind === 'audio' ? settings.allowMic : settings.allowVideo;
}
