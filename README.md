# Spickern

A fast, phone-friendly dart score tracker. No build step, no dependencies: plain HTML, CSS and JavaScript.

## Features

- **301 or 501**, with or without **double out**
- Any number of players (up to 8). Names are remembered for next time, and you can reorder or shuffle them
- **Dart-by-dart input**: tap `Double` or `Triple`, then the number. Single taps are singles. Plus `Miss`, `25`, `Bull` and `Undo`
- Automatic **bust** detection (overshoot, leaving 1, or not finishing on a double)
- **Checkout suggestions** for the darts left in the turn
- Live 3-dart average, last turn, best turn, and legs won; the starting player rotates each leg
- Unlimited undo, including after a leg is won
- The game is saved in the browser, so a reload doesn't lose the score
- Keeps the screen awake during a game (where supported)
- **Statistics** for every player across all games: 3-dart average, first-9 average, legs won and win rate, best leg, top finish, top score, 180s / 140+ / 100+, busts, plus a list of recent games. Filter by 301 or 501
- **Stats file on your computer** (`spickern-stats.json`):
  - In Chrome or Edge, open or create the file once and every finished leg is saved to it automatically. Next time, click *Reconnect* (or *Open*) and your stats are loaded back in
  - In other browsers (Safari, Firefox, phones), use *Save file* after playing and *Load* next time
  - Loading a file merges it with what's already in the browser, so nothing is lost
- Keyboard on desktop: type `20`, `d` then `16`, `t` then `19`, `b` for bull, `0` for a miss, `Backspace` to undo

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.
