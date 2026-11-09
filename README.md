# Cyberpunk Mech-Flight & City Conquest

A 3D browser game built with **Three.js** and plain JavaScript, with no build step and no game engine. Pilot a fighter over a neon city, survive four waves of hostile drones, then take down the **Overlord** boss. Collect crystals, repaint your ship and upgrade it in the garage. It plays on desktop (keyboard) and on phones and tablets (touch).

**[▶ Play the live demo](https://cybermech-flight.netlify.app)**

<!-- Add a screenshot or GIF here, e.g. ![Gameplay](docs/gameplay.png) -->

## Gameplay

- **4 escalating waves** (4, 6, 8 and 10 drones). Each wave is faster, tougher and fires more often.
- **Boss fight:** the Overlord drone (60 HP) launches minions as its health drops.
- **Enemy AI** with several states: patrol, chase (weaving side to side), wind-up (telegraphed with a red glow) and dash attacks.
- **Weapons:** hold-to-fire laser, homing rockets (10 slots) and a combo multiplier for chained kills within 3 seconds.
- **Rockets** regenerate one slot every 3.5 s, or refill all slots with a ~1 s quick reload.
- **Power-ups** floating in the city: Shield (8 s) and Triple Laser (10 s).
- **Nitro boost**, plus crystals that are earned from pickups, kills and the boss.
- **4 camera modes:** Chase, Cockpit, Top-Down and Close.
- **Radar** that rotates with the player's heading.

## Garage and progression

- **6 paint colors** (Stock, Red, Blue, Green, Purple, Pink), unlocked with crystals.
- **3 upgrades** (Top Speed, Nitro, Handling), each with 5 levels and rising crystal costs.
- **Level select:** start a new run from any wave you have reached.
- **Settings:** sound, vibration (on supported phones) and a progress reset.
- **Auto-save** through `localStorage`; the game still runs if storage is blocked (for example in private mode).

## Controls

| Action | Keyboard | Touch |
|---|---|---|
| Fly | `W` `A` `S` `D` / arrow keys | On-screen joystick |
| Fire laser | `Space` (hold) | **Fire** button (hold) |
| Nitro boost | `Shift` (hold) | **Boost** button (hold) |
| Homing rocket | `F` or `E` | **Rocket** button |
| Reload rockets | `R` | Reload button (top left) |
| Switch camera | `C` | Camera button (top left) |
| Pause | `Esc` or `P` | Pause button (top left) |
| Toggle sound | `M` | Settings menu |

The joystick, Fire, Boost and Rocket buttons are tracked per finger, so they can be used at the same time.

## Technical highlights

- **Custom game loop** with frame-rate independent movement and smoothing (damped interpolation).
- **`InstancedMesh`** renders the city's buildings in a small number of draw calls.
- **One input layer** merges keyboard, virtual joystick and hold-buttons (Pointer Events with pointer capture) into a single set of controls.
- **Mobile-aware rendering:** bloom post-processing is enabled on desktop only, and the pixel ratio is capped (1.5 on touch devices, 2 on desktop).
- **GLB model pipeline:** models are loaded with `GLTFLoader`, auto-scaled to a target size, and re-tinted at runtime for the paint system (the original colors are kept so repaints never stack).
- **Procedural audio** generated with the Web Audio API, so no sound files are needed.
- **Responsive UI** for portrait and landscape, with safe-area insets for notched phones.
- **Data-driven config:** waves, rockets, rewards, paints and upgrades are defined in one `CFG` block and a few constant tables.
- **Automatic deploys:** every push to `main` goes live on Netlify.

## Tech stack

- JavaScript (ES modules, import maps)
- [Three.js](https://threejs.org/) `0.170.0` loaded from a CDN (GLTFLoader, EffectComposer, UnrealBloomPass)
- HTML5 Canvas (radar) and CSS3 (HUD and menus)
- Netlify for hosting

## Run locally

The game loads `.glb` models, so it has to be served over HTTP; opening `index.html` directly will not work. An internet connection is needed because Three.js is loaded from a CDN.

```bash
git clone https://github.com/Bangardhian/game-pecawat.git
cd game-pecawat

# pick one:
npx serve .
# or
python -m http.server 8000
```

Then open the address printed in the terminal (for example `http://localhost:8000`).

**Tip for model orientation:** the player model can be rotated without editing code, for example `index.html?yaw=0`, `?yaw=180`, `?pitch=90` or `?roll=180` (degrees).

## Project structure

```
game-pecawat/
├── assets/
│   ├── pesawat_player.glb   # player fighter model
│   ├── drone_musuh.glb      # enemy drone model
│   └── coin.glb             # crystal pickup model
├── index.html               # page, HUD and menu markup
├── main.js                  # game loop, input, AI, waves, boss, garage, audio
└── style.css                # HUD, menus and responsive layout
```

## What I learned

- Building a game loop from scratch and keeping movement stable across different frame rates
- Using instancing and a capped pixel ratio to keep performance steady on mobile
- Designing one input system that works for keyboard and multi-touch
- Building simple state-machine AI and tuning difficulty across waves
- Saving player progress safely and building responsive game menus

## Roadmap

- [ ] More enemy types and a longer campaign
- [ ] Global leaderboard
- [ ] Additional languages (the UI already uses a translation table)

## Author

**Bagus Ardian Prabowo**
GitHub: [@Bangardhian](https://github.com/Bangardhian)