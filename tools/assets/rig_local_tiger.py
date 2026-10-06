"""Rig the existing project-owned static tiger locally; never modifies the source GLB.

Run alongside build_wildlife.py: blender -b --factory-startup --disable-autoexec
 --python rig_local_tiger.py -- OUTPUT_DIRECTORY INPUT.glb
This is a geometric binding and locally authored motion, not the Amil download.
"""
import bpy
import math
import os
import sys
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.dirname(__file__))
from build_wildlife import Animal, PI

args = sys.argv[sys.argv.index('--')+1:]
a = Animal('TigerRigged')
bpy.ops.import_scene.gltf(filepath=args[1])
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# Source head is on -Z in glTF. Rotate geometry before fitting the +Z-facing rig.
for o in meshes:
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    o.matrix_world = Matrix.Rotation(PI, 4, 'Z') @ o.matrix_world
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
coords = [v.co.copy() for o in meshes for v in o.data.vertices]
low = Vector(tuple(min(v[i] for v in coords) for i in range(3)))
high = Vector(tuple(max(v[i] for v in coords) for i in range(3)))
height = high.z-low.z
mid = (low+high)/2
for o in meshes:
    for v in o.data.vertices:
        v.co = (v.co-Vector((mid.x,mid.y,low.z)))/height
# Fitted to this specific tiger's normalized body, not a general-purpose auto-rigger.
a.bone('root',(0,0,0),(0,0,0.1))
a.bone('hips',(0,0.38,0.68),(0,0.12,0.73),'root')
a.bone('spine',(0,0.12,0.73),(0,-0.27,0.73),'hips')
a.bone('neck',(0,-0.27,0.73),(0,-0.46,0.77),'spine')
a.bone('head',(0,-0.46,0.77),(0,-0.68,0.76),'neck')
for side in [-1,1]:
    for which,y in [('front',-0.33),('back',0.38)]:
        upper=f'{which}.{side}'
        start=(side*0.15,y,0.69)
        joint=(side*0.17,y+(0.065 if which=='back' else 0.015),0.35)
        foot=(side*0.17,y-0.04,0.09)
        a.bone(upper,start,joint,'spine' if which=='front' else 'hips')
        a.bone(upper+'.lower',joint,foot,upper)
        a.bone(upper+'.foot',foot,(side*0.17,y-0.16,0.06),upper+'.lower')
a.bone('tail0',(0,0.48,0.7),(0,0.65,0.48),'hips')
a.bone('tail1',(0,0.65,0.48),(0,0.73,0.25),'tail0')
for o in meshes:
    for name in a.bones:
        o.vertex_groups.new(name=name)
    for v in o.data.vertices:
        p=v.co
        # Continuous distance field avoids hard binding seams at shoulder/hip cut planes.
        candidates=[name for name in a.bones if name != 'root']
        distances=[]
        for name in candidates:
            start,end,_=a.bones[name]
            line=end-start
            nearest=start+line*max(0,min(1,(p-start).dot(line)/line.length_squared))
            distances.append((max((p-nearest).length,0.025),name))
        nearest=sorted(distances)[:4]
        total=sum(1/d**4 for d,_ in nearest)
        for d,name in nearest:
            o.vertex_groups[name].add([v.index],(1/d**4)/total,'REPLACE')
a.parts=meshes
a.skin()
def idle(t):
    a.pose('head',(0,0,1),math.sin(t*2*PI)*0.035)
    a.pose('tail0',(0,0,1),math.sin(t*2*PI)*0.1)
    a.pose('tail1',(0,0,1),math.sin(t*2*PI-0.4)*0.1)
def gait(t,fast=False):
    idle(t)
    for s in [-1,1]:
        for which in ['front','back']:
            phase=(PI if s<0 else 0)+(PI if which=='back' else 0)
            v=math.sin(t*2*PI+phase)
            amp=0.20 if fast else 0.13
            a.pose(f'{which}.{s}',(1,0,0),v*amp)
            a.pose(f'{which}.{s}.lower',(1,0,0),-max(0,v)*amp)
            a.pose(f'{which}.{s}.foot',(1,0,0),-v*amp*0.3)
def gallop(t):
    # A rotary gallop, the big cats' fast gait: hind left, hind right, fore right, fore left,
    # with the legs gathered under a flexed spine in the airborne phase. One cycle per clip;
    # the client plays it at the stride rate the animal's ground speed needs.
    flex = math.cos(2*PI*(t-0.9))  # +1 gathered (back arched), -1 stretched out
    a.root_offset(z=0.035*math.cos(2*PI*(t-0.95)))
    a.pose('root',(1,0,0),0.05*math.sin(2*PI*(t-0.05)))
    a.pose('hips',(1,0,0),-0.10*flex)
    a.pose('spine',(1,0,0),0.20*flex)
    a.pose('neck',(1,0,0),-0.09*flex-0.04*math.sin(2*PI*(t-0.05)))
    a.pose('head',(1,0,0),-0.05*flex)
    a.pose('tail0',(1,0,0),0.55+0.12*math.sin(2*PI*(t-0.2)))
    a.pose('tail1',(1,0,0),0.2+0.18*math.sin(2*PI*(t-0.35)))
    duty, stance, reach = 0.36, 0.42, 0.18
    for which,side,touchdown in [('back',-1,0.0),('back',1,0.1),('front',1,0.42),('front',-1,0.52)]:
        u = (t-touchdown) % 1
        bone = f'{which}.{side}'
        if u < duty:  # on the ground: the leg sweeps back at a steady rate, paw flat
            k = u/duty
            angle = -stance+2*stance*k
            give = 0.12*math.sin(PI*k)
            a.pose(bone,(1,0,0),angle)
            a.pose(bone+'.lower',(1,0,0),give if which=='front' else -give)
            a.pose(bone+'.foot',(1,0,0),-angle*0.8)
        else:  # in the air: folds and swings forward to reach for the next stride
            k = (u-duty)/(1-duty)
            angle = stance*math.cos(PI*k)+reach*math.sin(2*PI*k)
            fold = math.sin(PI*k)**1.5
            a.pose(bone,(1,0,0),angle)
            a.pose(bone+'.lower',(1,0,0),1.05*fold if which=='front' else -0.9*fold)
            a.pose(bone+'.foot',(1,0,0),(0.7 if which=='front' else 0.5)*fold-angle*0.3)
def pounce(t):
    # The final spring onto the prey: a short crouch, hind legs driving the body forward and up,
    # forelegs thrown out to grab, then the landing onto it with the head down for the bite.
    # Played once (0 -> 1) over the last moments before contact.
    crouch = math.sin(PI*min(1, t/0.25))*(1 if t < 0.25 else 0)
    air = math.sin(PI*max(0, min(1, (t-0.2)/0.65)))
    land = max(0, (t-0.75)/0.25)
    a.root_offset(z=-0.06*crouch+0.16*air)
    a.pose('root',(1,0,0),0.1*crouch-0.16*air+0.18*land)
    a.pose('hips',(1,0,0),0.08*air)
    a.pose('spine',(1,0,0),-0.14*air+0.1*crouch)
    a.pose('neck',(1,0,0),-0.1*air+0.3*land)
    a.pose('head',(1,0,0),0.25*land)
    a.pose('tail0',(1,0,0),0.4+0.2*air)
    a.pose('tail1',(1,0,0),0.3*air)
    for side in [-1,1]:
        reach = -0.95*air-0.2*crouch+0.4*land
        a.pose(f'front.{side}',(1,0,0),reach)
        a.pose(f'front.{side}.lower',(1,0,0),0.5*crouch+0.15*air-0.2*land)
        a.pose(f'front.{side}.foot',(1,0,0),-0.5*air+0.3*land)
        drive = 0.7*air-0.35*crouch
        a.pose(f'back.{side}',(1,0,0),drive)
        a.pose(f'back.{side}.lower',(1,0,0),-0.7*crouch+0.1*air)
        a.pose(f'back.{side}.foot',(1,0,0),0.4*air)
def bite(t):
    # Holding the prey down by the throat or nape until it dies: body low and braced, forelegs
    # forward pinning it, hind legs crouched and gripping the ground, jaws clamped with the neck
    # tugging and twisting against the prey's struggle, tail lashing.
    w = 2*PI*t
    a.root_offset(z=-0.1+0.01*math.sin(2*w))
    a.pose('root',(1,0,0),0.04)
    a.pose('spine',(1,0,0),0.1+0.03*math.sin(w))
    a.pose('neck',(1,0,0),0.24+0.06*math.sin(2*w+0.5))
    a.pose('neck',(0,1,0),0.1*math.sin(w))
    a.pose('head',(1,0,0),0.12+0.05*math.sin(2*w))
    a.pose('head',(0,1,0),0.08*math.sin(w+1))
    a.pose('tail0',(0,0,1),0.35*math.sin(w*1.5))
    a.pose('tail0',(1,0,0),0.25)
    a.pose('tail1',(0,0,1),0.4*math.sin(w*1.5-0.7))
    for side in [-1,1]:
        a.pose(f'front.{side}',(1,0,0),-0.55+0.06*math.sin(2*w+side))
        a.pose(f'front.{side}.lower',(1,0,0),-0.15)
        a.pose(f'front.{side}.foot',(1,0,0),0.45)
        a.pose(f'back.{side}',(1,0,0),-0.42+0.05*math.sin(2*w-side))
        a.pose(f'back.{side}.lower',(1,0,0),-0.5)
        a.pose(f'back.{side}.foot',(1,0,0),0.75)
def crouch():
    # Tigers feed and drink low over the carcass or the water: body down, forelegs braced in
    # front, hind legs crouched under (the same footing as the hold, without the struggle).
    a.root_offset(z=-0.12)
    a.pose('root',(1,0,0),0.03)
    a.pose('tail0',(1,0,0),0.1); a.pose('tail1',(1,0,0),0.3)
    for side in [-1,1]:
        a.pose(f'front.{side}',(1,0,0),-0.5)
        a.pose(f'front.{side}.lower',(1,0,0),-0.15)
        a.pose(f'front.{side}.foot',(1,0,0),0.45)
        a.pose(f'back.{side}',(1,0,0),-0.45)
        a.pose(f'back.{side}.lower',(1,0,0),-0.5)
        a.pose(f'back.{side}.foot',(1,0,0),0.8)
def feed(t):
    # Tearing at the carcass: the head pulls down and back, the neck twists.
    crouch()
    w = 2*PI*t
    a.pose('neck',(1,0,0),0.3+0.1*max(0, math.sin(2*w)))
    a.pose('neck',(0,1,0),0.12*math.sin(w))
    a.pose('head',(1,0,0),0.25+0.1*math.sin(2*w+0.8))
    a.pose('tail0',(0,0,1),0.15*math.sin(w))
def drink(t):
    # Lapping at the water's edge: quick small dips of the head.
    crouch()
    a.pose('neck',(1,0,0),0.4)
    a.pose('head',(1,0,0),0.3+0.05*math.sin(t*12*PI))
def death(t):
    v=min(1,t*1.5);v=v*v*(3-2*v)
    a.pose('root',(0,1,0),v*1.48)
    a.root_offset(z=0.30*v)
for name,seconds,fn in [('Idle',3,idle),('Walk',1.6,gait),('Run',0.8,lambda t:gait(t,True)),('Gallop',1.0,gallop),('Pounce',0.8,pounce),('Bite',2.0,bite),
                        ('Sneak',2.2,gait),('Eating',2,feed),('Drinking',2,drink),('Resting',4,idle),('Death',2,death)]:
    a.animate(name,seconds,fn)
a.export()
