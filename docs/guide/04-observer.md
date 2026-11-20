# 4. The observer

The observer (`packages/client`) is the 3D site visitors open. It is built with three.js and
Vite, holds no simulation of its own, and renders only what the server reports.

## Getting around

| To | Mouse / trackpad | Touch | Keyboard |
|---|---|---|---|
| Pan | Drag | One finger | W A S D |
| Rotate | Right- or Shift-drag; trackpad sideways swipe | Two fingers | Q / E, ← / → |
| Look from higher or lower | — | — | ↑ / ↓ |
| Zoom (toward the pointer) | Wheel | Pinch | + / − |

A camera pad on screen does the same (turn left and right, look higher and lower, zoom in and
out, reset view), so the view is easy to control without a keyboard. Panning stays over the
island, and a flick carries on with a little inertia. **H** hides the interface for a clean
view; `?cinema` in the address does the same from the start.

## Following an animal

- **Tap or click any animal** to follow it. The camera orbits it as it moves; dragging still
  turns the view round it.
- **Explore** releases the animal and rises to a wide view of the island.
- The **animal card** shows species, sex, age, life stage and generation; hunger, thirst,
  fatigue and fear; what it is doing and its current goal; and how many people are watching.
  From it:
  - **Life story, family and skills**: its passport and lineage.
  - **Replay this life**: its recorded track replayed with its recorded moments.
  - **History**: its retained events, page by page.
  - **Share**: a short text card with a link that opens the site following that animal
    (`/#animal=<id>`).
  - **Watch a recorded hunt**: any hunt it took part in, both animals on one timeline.

## The rest of the screen

- **Top bar:** the world clock and season, the population (tap for counts by species), and
  how many AI agents are playing (with a link to "Play as an AI agent").
- **Happening now:** a feed of recorded events as they happen on the island.
- **Event map:** where hunts, births, deaths and arrivals happened. Choosing one flies there
  and, for a hunt, can replay it.
- **Village:** the household, each person's tasks and recent history.
- **View options:** graphics quality (Auto, Smooth / low power, Balanced, High detail) and
  ambient sound (rain, wind, nearby water, and calls only from animals recorded fleeing or
  hunting).
- The layout adapts to phones without sideways scrolling.

## Replays

A replay plays recorded time, never a re-simulation. Play, pause, seek and speed controls run
on a local clock and never write to the world. A hunt replay keeps both animals in frame unless
you take the camera, and a replay of a kill runs a few seconds past the death so the aftermath
is seen. Terrain and weather in a replay are today's, not the past's; the page says so.

## How animals are animated

Animation is presentation. Positions, timing and outcomes always come from the recording; these
rules decide only which clip plays and how fast.

- **State picks the clip.** A grazing animal plays its eating clip, never a walk; a resting
  one its idle or rest clip. A model without a suitable clip plays nothing rather than
  something the server did not say.
- **Legs keep pace with the ground.** Each drawn animal's ground speed is measured from its
  positions. The gait (walk, trot, gallop) is picked from its Froude number, the standard
  dynamic-similarity measure for legged animals, with hysteresis so it does not flicker. The
  stride rate comes from Alexander's stride-length relation. A sprinting tiger takes about 2.4
  strides a second; a walking elephant about one every two seconds. How many strides a clip
  holds is read from the clip itself.
- **An animal that is not covering ground stands.** A stride clip never plays on a still body.
- **Every animal moves on its own.** Each has its own phase in its clips, so a herd or a line
  of drinkers never moves in unison.
- **Drinkers and grazers look up.** They lift their heads to look round for a couple of
  seconds every 8–13 seconds, on their own rhythm, blended in smoothly. The tiger, which feeds
  crouched, does not.
- **A kill is a sequence.** The hunter springs the last moments before contact (pounce), seizes
  and holds the prey (hold); the prey is struck, falls and struggles until the recorded death,
  then lies still while the hunter feeds. A prey that breaks free fights the grip on its feet
  and then runs. Hunts recorded before the hold existed show the prey collapsing at contact,
  where it was recorded dead.
- **Climbing and flight** use recorded altitude: a langur or squirrel is stood upright against
  its tree; a vulture flaps when climbing or descending and glides when level.
- Elephants reach their trunk to the ground to feed and drink.

## Performance

The observer keeps a frame-time budget: detailed models, foliage and grass only near the camera,
lighter cards and dots farther away, instancing for vegetation, and a quality tier that adapts
to the device. `tools/e2e/perf.ts` measures it in a real browser.
