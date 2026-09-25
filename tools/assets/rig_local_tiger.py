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
def feed(t):
    idle(t); a.pose('neck',(1,0,0),0.35); a.pose('head',(1,0,0),0.2+math.sin(t*4*PI)*0.025)
def death(t):
    v=min(1,t*1.5);v=v*v*(3-2*v)
    a.pose('root',(0,1,0),v*1.48)
    a.root_offset(z=0.30*v)
for name,seconds,fn in [('Idle',3,idle),('Walk',1.6,gait),('Run',0.8,lambda t:gait(t,True)),
                        ('Sneak',2.2,gait),('Eating',2,feed),('Drinking',2,feed),('Resting',4,idle),('Death',2,death)]:
    a.animate(name,seconds,fn)
a.export()
