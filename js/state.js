// Mutable state shared between modules. Imported bindings are read-only, so values that several
// modules change live on this object instead.
export const state = {
  yaw: 0, pitch: -0.15, // where the player is looking
  camMode: 1,           // 0 = first person, 1 = third person
  time: 0,              // seconds of game time; drives the animations, stars and waves
};
