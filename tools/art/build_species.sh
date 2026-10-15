#!/bin/sh
# Rebuilds the generated species models from their Tripo meshes (kept outside the repository,
# under $ART, as <species>-tripo.glb) onto the existing rigs. See ASSET-CREDITS.md for jobs.
#   ART=/path/to/meshes tools/art/build_species.sh [species ...]
set -eu
cd "$(dirname "$0")/../.."
: "${ART:?set ART to the directory holding <species>-tripo.glb}"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
RIGS=packages/client/public/assets/animals
OUT="${OUT:-$RIGS}"

# Tripo meshes face +X (head first); FORWARD overrides. PITCH (degrees) levels a body that comes out
# tilted (the flying eagle: FORWARD=-Y PITCH=46.5).
# species  rig       output         bones that must not deform  clips to review  [fit]
# The elephant rig skins much of its body to its IK and knee-pole bones; they are kept from deforming.
table='
boar     Bull     WildBoar      Tail4,Tail5,Tail6,Tail7  Idle,Walk,Eating,Gallop,Idle_Headlow,Death  bbox
chital   Deer     Chital        -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
chitalhind Deer   ChitalHind    -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
sambar   Stag     Sambar        -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
gaur     Bull     Gaur          -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
dhole    Fox      Dhole         -                        Idle,Walk,Eating,Gallop,Idle_2_HeadLow,Death
jackal   Fox      Jackal        -                        Idle,Walk,Eating,Gallop,Idle_2_HeadLow,Death
hare     Rabbit   Hare          -                        Idle,Gallop,Jump,Resting,Death  bbox
langur   Langur   GreyLangur    -                        Idle,Walk,Run,Eating,Drinking,Death
squirrel Squirrel GiantSquirrel -                        Idle,Walk,Run,Eating,Drinking,Death
vulture  Vulture  WhiteRumpedVulture -                   Idle,Walk,Flap,Glide,Eating,Death
duiker   Deer     BlueDuiker    -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
chevrotain Deer   WaterChevrotain -                      Idle,Walk,Eating,Gallop,Idle_Headlow,Death
bay      Deer     BayDuiker     -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
peters   Deer     PetersDuiker  -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
hog      Bull     RedRiverHog   Tail4,Tail5,Tail6,Tail7  Idle,Walk,Eating,Gallop,Idle_Headlow,Death  bbox
buffalo  Bull     ForestBuffalo -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death  feet Head
sitatunga Deer    Sitatunga     -                        Idle,Walk,Eating,Gallop,Idle_Headlow,Death
elephant ElephantWalking ForestElephant TrunkIK,Bone.016,Bone.017,Bone.018,Bone.019,Bone.020,KneeBack.L,KneeBack.L.001,KneeFront.L,KneeFront.L.001  Idle,Walk,Eating,Angry
eagle    Vulture  CrownedEagle  -                        Idle,Walk,Flap,Glide,Eating,Death  bbox
eagleflight Vulture CrownedEagleFlying -                 Flap,Glide  bbox
mangabey Langur   AgileMangabey -                        Idle,Walk,Run,Eating,Drinking,Death
'
wanted="$*"
echo "$table" | while read -r species rig out nodeform clips fit rigidhead; do
  [ -n "$species" ] || continue
  if [ -n "$wanted" ]; then case " $wanted " in *" $species "*) ;; *) continue ;; esac; fi
  [ "$nodeform" = "-" ] && nodeform=""
  mkdir -p "$ART/review/$species"
  "$BLENDER" -b --python tools/art/bind_to_rig.py -- --mesh "$ART/$species-tripo.glb" --rig "$RIGS/$rig.glb" \
    --mesh-forward="${FORWARD:-X}" --out "$ART/review/$species/$out.glb" --no-deform "$nodeform" --review-clips "$clips" --fit "${fit:-feet}" --pitch="${PITCH:-0}" ${rigidhead:+--rigid-head "$rigidhead"} 2>&1 \
    | grep -E "FIT|SKIN|WROTE|Traceback|Error" | sed "s/^/$species: /"
  # The elephant rig's own walk barely lifts its feet and it has no drinking or death clip.
  if [ "$species" = elephant ]; then
    "$BLENDER" -b --python tools/art/forest_elephant_clips.py -- --in "$ART/review/$species/$out.glb" \
      --out "$ART/review/$species/$out.glb" 2>&1 | grep -E "AXES|WALK|DRINKING|DEATH|WROTE|Traceback|Error" | sed "s/^/$species: /"
  fi
  cp "$ART/review/$species/$out.glb" "$OUT/$out.glb"
done
