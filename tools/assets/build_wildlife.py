"""Original, reproducible stylized wildlife. Blender 4; no paid/generative API.

Usage: blender -b --factory-startup --python build_wildlife.py -- OUTPUT_DIRECTORY
Meshes, skin weights and clips are authored here. These are stylized approximations,
not scanned zoological reference models. Coordinates: Z up, -Y forward.
"""
import bpy
import math
import os
import sys
from mathutils import Vector, Quaternion, kdtree

OUT = sys.argv[sys.argv.index('--') + 1]
os.makedirs(OUT, exist_ok=True)
PI = math.pi


def material(name, color, roughness=0.85):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    return m


class Animal:
    def __init__(self, name):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        for a in list(bpy.data.actions):
            bpy.data.actions.remove(a)
        self.name = name
        self.parts = []
        self.bones = {}
        self.rig = None

    def bone(self, name, head, tail, parent=None):
        self.bones[name] = (Vector(head), Vector(tail), parent)

    def ellipsoid(self, name, pos, size, mat, bone, rotation=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, location=pos)
        o = bpy.context.object
        o.name = name
        o.scale = size
        if rotation:
            o.rotation_mode = 'QUATERNION'
            o.rotation_quaternion = rotation
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        o.data.materials.append(mat)
        for p in o.data.polygons:
            p.use_smooth = True
        o.vertex_groups.new(name=bone).add(range(len(o.data.vertices)), 1.0, 'REPLACE')
        self.parts.append(o)
        return o

    def segment(self, name, start, end, radius, mat, bone, width=None):
        a, b = Vector(start), Vector(end)
        return self.ellipsoid(name, (a+b)/2, (radius, width or radius, (b-a).length * 0.59),
                              mat, bone, (b-a).to_track_quat('Z', 'Y'))

    def tail_surface(self, points, radii, mat):
        """One continuous curved surface, rather than disconnected joint sausages."""
        points = [Vector(p) for p in points]
        vertices, faces, bindings = [], [], []
        steps, sides = 64, 12
        def curve(u):
            i = min(len(points)-2, int(u))
            t = u-i
            p0,p1,p2,p3 = points[max(0,i-1)],points[i],points[i+1],points[min(len(points)-1,i+2)]
            return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
        for ring in range(steps+1):
            u = ring/steps*(len(points)-1)
            i = min(len(points)-2,int(u)); t = u-i
            center = curve(u)
            tangent = (curve(min(len(points)-1,u+0.01))-curve(max(0,u-0.01))).normalized()
            across = tangent.cross(Vector((1,0,0))).normalized()
            radius = max(0.006,radii[i]*(1-t)+radii[i+1]*t)
            for j in range(sides):
                angle = j/sides*2*PI
                vertices.append(center+radius*(Vector((1,0,0))*math.cos(angle)+across*math.sin(angle)))
                bindings.append((i,t))
                if ring:
                    a0=(ring-1)*sides+j; a1=(ring-1)*sides+(j+1)%sides
                    b0=ring*sides+j; b1=ring*sides+(j+1)%sides
                    faces.append((a0,a1,b1,b0))
        faces.extend([tuple(reversed(range(sides))),tuple(steps*sides+j for j in range(sides))])
        data=bpy.data.meshes.new('Continuous tail'); data.from_pydata(vertices,[],faces); data.update()
        obj=bpy.data.objects.new('Continuous tail',data); bpy.context.collection.objects.link(obj)
        obj.data.materials.append(mat)
        groups=[obj.vertex_groups.new(name='tail'+str(i)) for i in range(len(points)-1)]
        for v,(i,t) in enumerate(bindings):
            blend=max(0,t-0.5)
            groups[i].add([v],1-blend,'REPLACE')
            if blend:
                groups[min(i+1,len(groups)-1)].add([v],blend,'ADD')
        for p in data.polygons: p.use_smooth=True
        self.parts.append(obj)

    def skin(self):
        data = bpy.data.armatures.new(self.name + 'Skeleton')
        self.rig = bpy.data.objects.new(self.name + 'Rig', data)
        bpy.context.collection.objects.link(self.rig)
        bpy.context.view_layer.objects.active = self.rig
        self.rig.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        for name, (head, tail, parent) in self.bones.items():
            b = data.edit_bones.new(name)
            b.head, b.tail = head, tail
            if parent:
                b.parent = data.edit_bones[parent]
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.select_all(action='DESELECT')
        for p in self.parts:
            p.select_set(True)
        bpy.context.view_layer.objects.active = self.parts[0]
        bpy.ops.object.join()
        mesh = bpy.context.object
        mesh.name = self.name + 'Mesh'
        if self.name in {'Langur', 'Squirrel', 'Hare'}:
            # Unite intersecting sculpt volumes; restore authored weights from nearest surface.
            # A small voxel size retains face details while joining the sculpt volumes.
            source = [(v.co.copy(), [(g.group,g.weight) for g in v.groups]) for v in mesh.data.vertices]
            tree = kdtree.KDTree(len(source))
            for i,(co,_) in enumerate(source):
                tree.insert(co,i)
            tree.balance()
            remesh = mesh.modifiers.new('Unify sculpt volumes','REMESH')
            remesh.mode = 'VOXEL'
            remesh.voxel_size = 0.012
            remesh.use_smooth_shade = True
            bpy.ops.object.modifier_apply(modifier=remesh.name)
            smooth = mesh.modifiers.new('Soften volume joins','SMOOTH')
            smooth.factor = 0.8
            smooth.iterations = 4
            bpy.ops.object.modifier_apply(modifier=smooth.name)
            decimate = mesh.modifiers.new('Realtime surface budget','DECIMATE')
            decimate.ratio = 0.32
            bpy.ops.object.modifier_apply(modifier=decimate.name)
            for v in mesh.data.vertices:
                weights = {}
                for _,i,distance in tree.find_n(v.co, 8):
                    for group,weight in source[i][1]:
                        weights[group] = weights.get(group,0) + weight / max(distance,0.006)**2
                total = sum(weights.values())
                for group,weight in weights.items():
                    mesh.vertex_groups[group].add([v.index],weight/total,'REPLACE')
        mesh.parent = self.rig
        mod = mesh.modifiers.new('Skin', 'ARMATURE')
        mod.object = self.rig
        self.rig.animation_data_create()
        return mesh

    def pose(self, name, axis, angle):
        if name not in self.rig.pose.bones:
            return
        p = self.rig.pose.bones[name]
        # Convert a model-space axis into the bone's rest coordinates.
        local_axis = p.bone.matrix_local.to_quaternion().inverted() @ Vector(axis)
        p.rotation_quaternion = p.rotation_quaternion @ Quaternion(local_axis, angle)

    def animate(self, name, duration, fn):
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        self.rig.animation_data.action = action
        frames = round(duration * 24)
        for frame in range(frames + 1):
            t = frame / frames
            for p in self.rig.pose.bones:
                p.rotation_mode = 'QUATERNION'
                p.rotation_quaternion = (1, 0, 0, 0)
                p.location = (0, 0, 0)
            fn(t)
            for p in self.rig.pose.bones:
                p.keyframe_insert('rotation_quaternion', frame=frame)
                p.keyframe_insert('location', frame=frame)
        for f in action.fcurves:
            for k in f.keyframe_points:
                k.interpolation = 'LINEAR'

    def root_offset(self, x=0, y=0, z=0):
        p = self.rig.pose.bones['root']
        p.location = p.bone.matrix_local.to_quaternion().inverted() @ Vector((x,y,z))

    def export(self):
        self.rig.animation_data.action = bpy.data.actions['Idle']
        bpy.context.scene.frame_set(0)
        bpy.context.scene.render.fps = 24
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, self.name + '.blend'))
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, self.name + '.glb'), export_format='GLB',
                                  export_animations=True, export_force_sampling=True,
                                  export_frame_range=False, export_skins=True,
                                  export_cameras=False, export_lights=False)


def mammal(kind):
    a = Animal(kind)
    langur = kind == 'Langur'
    hare = kind == 'Hare'
    coat = material('Silver coat' if langur else 'Chestnut coat', (0.42, 0.39, 0.32) if langur else (0.26, 0.12, 0.055))
    cream = material('Soft undercoat', (0.71, 0.65, 0.51))
    dark = material('Face and digits', (0.025, 0.021, 0.018))
    eye = material('Dark glossy eyes', (0.007, 0.005, 0.003), 0.19)
    amber = material('Eye iris', (0.27, 0.13, 0.03), 0.3)
    pink = material('Inner ear', (0.34, 0.19, 0.13))
    # Quadrupedal rest pose; langur has longer limbs and slender body.
    h = 0.72 if langur else 0.37
    rear, front = 0.29, -0.3
    a.bone('root', (0,0,0), (0,0,0.15))
    a.bone('hips', (0,rear,h), (0,0,h), 'root')
    a.bone('spine', (0,0,h), (0,front,h+0.05), 'hips')
    a.bone('neck', (0,front,h+0.05), (0,-0.47,h+0.16), 'spine')
    a.bone('head', (0,-0.47,h+0.16), (0,-0.63,h+0.17), 'neck')
    a.ellipsoid('Haunch', (0,0.23,h-0.04), (0.19,0.28,0.23), coat, 'hips')
    a.ellipsoid('Torso', (0,-0.06,h), (0.16,0.35,0.2), coat, 'spine')
    a.ellipsoid('Underbelly', (0,-0.1,h-0.1), (0.143,0.25,0.13), cream, 'spine')
    a.segment('Neck', (0,-0.3,h+0.03), (0,-0.47,h+0.19), 0.125, coat, 'neck')
    a.ellipsoid('Skull', (0,-0.51,h+0.2), (0.14,0.155,0.155), cream if langur else coat, 'head')
    if langur:
        a.ellipsoid('Black face mask', (0,-0.605,h+0.23), (0.112,0.07,0.12), dark, 'head')
    a.ellipsoid('Muzzle', (0,-0.634,h+0.153), (0.09,0.068,0.078), dark if langur else cream, 'head')
    a.ellipsoid('Nose', (0,-0.69,h+0.183), (0.035,0.028,0.021), dark, 'head')
    for side in [-1,1]:
        x = side * 0.11
        a.ellipsoid('Eye socket', (x,-0.604,h+0.247), (0.043,0.025,0.041), dark if langur else coat, 'head')
        a.ellipsoid('Eye', (x,-0.624,h+0.25), (0.025,0.014,0.026), eye, 'head')
        a.ellipsoid('Iris', (x,-0.637,h+0.25), (0.012,0.006,0.014), amber, 'head')
        a.ellipsoid('Pupil', (x,-0.642,h+0.25), (0.006,0.004,0.009), eye, 'head')
        earh = 0.20 if hare else 0.07
        earx = side*(0.145 if langur else 0.115)
        earz = h+(0.22 if langur else 0.33+earh*0.5)
        a.ellipsoid('Ear', (earx,-0.47,earz), (0.047,0.035,earh), coat, 'head')
        a.ellipsoid('Ear inner', (earx,-0.496,earz), (0.03,0.012,earh*0.75), pink, 'head')
        for which,y in [('front',front),('back',rear)]:
            upper = f'{which}.{side}'
            lower, foot = upper+'.lower', upper+'.foot'
            start = (side*0.14,y,h-0.06)
            joint = (side*0.17,y+(-0.09 if which=='front' else -0.15), h*0.46)
            end = (side*0.17,y+(-0.11 if which=='front' else 0.02),0.075)
            toe = (end[0],end[1]-(0.14 if hare else 0.09),0.04)
            a.bone(upper,start,joint,'spine' if which=='front' else 'hips')
            a.bone(lower,joint,end,upper)
            a.bone(foot,end,toe,lower)
            a.segment(upper,start,joint,0.068 if which=='front' else 0.096,coat,upper)
            a.segment(lower,joint,end,0.045,coat,lower)
            a.ellipsoid('Knee volume',joint,(0.052,0.052,0.052),coat,lower)
            a.ellipsoid(foot,(Vector(end)+Vector(toe))/2,(0.047,0.105 if hare else 0.07,0.036),dark if langur else coat,foot)
            if langur:
                for digit in range(4):
                    a.segment('Finger',(end[0]+(digit-1.5)*0.016,toe[1]+0.025,0.038),
                              (end[0]+(digit-1.5)*0.016,toe[1]-0.037,0.032),0.009,dark,foot)
    tail_points = [(0,0.47,h),(0,0.78,h+0.25),(0,0.96,h+0.68),(0,0.73,h+0.96),(0,0.44,h+0.88)]
    if hare:
        a.ellipsoid('Scut',(0,0.48,h+0.03),(0.085,0.1,0.08),cream,'hips')
    else:
        for i in range(len(tail_points)-1):
            name = 'tail'+str(i)
            a.bone(name,tail_points[i],tail_points[i+1],'hips' if i==0 else 'tail'+str(i-1))
        a.tail_surface(tail_points,[0.032,0.030,0.027,0.024,0.009] if langur else [0.055,0.12,0.18,0.14,0.01],coat)
    a.skin()
    def idle(t):
        a.pose('head',(0,0,1),math.sin(t*2*PI)*0.07)
        a.pose('spine',(1,0,0),math.sin(t*2*PI)*0.012)
        for i in range(4):
            a.pose('tail'+str(i),(0,1,0),math.sin(t*2*PI-i*0.5)*0.025)
    def gait(t,fast=False):
        amp = 0.48 if fast else 0.28
        for side in [-1,1]:
            for which in ['front','back']:
                phase = (0 if side==1 else PI) + (PI if which=='back' else 0)
                if hare and fast:
                    phase = 0 if which=='front' else PI
                v = math.sin(t*2*PI+phase)
                a.pose(f'{which}.{side}',(1,0,0),amp*v)
                a.pose(f'{which}.{side}.lower',(1,0,0),-max(0,v)*amp*0.9)
                a.pose(f'{which}.{side}.foot',(1,0,0),-amp*v*0.35)
        a.pose('spine',(1,0,0),math.sin(t*4*PI)*(0.06 if fast else 0.015))
        for i in range(4):
            a.pose('tail'+str(i),(0,1,0),math.sin(t*2*PI-i*0.6)*0.06)
    def feed(t,drinking=False):
        idle(t)
        a.pose('neck',(1,0,0),0.56 if langur else 0.38)
        a.pose('head',(1,0,0),0.32+math.sin(t*4*PI)*0.045)
        if not drinking:
            a.pose('head',(0,0,1),math.sin(t*4*PI)*0.035)
    def death(t):
        s = min(1,t*1.5); s = s*s*(3-2*s)
        a.pose('root',(0,1,0),s*1.45)
        a.root_offset(z=0.19*s)
        for side in [-1,1]:
            for which in ['front','back']:
                a.pose(f'{which}.{side}',(1,0,0),s*0.45)
    a.animate('Idle',3,idle)
    a.animate('Walk',1.5,lambda t:gait(t))
    a.animate('Run',0.65,lambda t:gait(t,True))
    a.animate('Eating',2,feed)
    a.animate('Drinking',2,lambda t:feed(t,True))
    a.animate('Resting',4,lambda t:(idle(t),a.root_offset(z=-0.025)))
    a.animate('Death',1.8,death)
    a.animate('Injured',2,lambda t:(idle(t),a.pose('front.1',(1,0,0),0.22)))
    a.export()


def vulture():
    a = Animal('Vulture')
    brown = material('Brown coverts',(0.115,0.075,0.044))
    wing = material('Dark flight feathers',(0.038,0.03,0.023))
    edges = material('Feather edging',(0.22,0.17,0.105))
    ruff = material('Pale neck ruff',(0.61,0.53,0.39))
    bare = material('Bare grey head',(0.29,0.27,0.25))
    beak = material('Horn beak',(0.33,0.30,0.23))
    eye = material('Eyes',(0.006,0.004,0.003),0.2)
    a.bone('root',(0,0,0),(0,0,0.2))
    a.bone('hips',(0,0.2,0.55),(0,-0.15,0.7),'root')
    a.bone('neck',(0,-0.22,0.77),(0,-0.38,1.05),'hips')
    a.bone('head',(0,-0.38,1.05),(0,-0.61,1.05),'neck')
    a.ellipsoid('Body',(0,0,0.65),(0.24,0.41,0.27),brown,'hips')
    a.segment('Bare neck',(0,-0.28,0.79),(0,-0.39,1.06),0.068,bare,'neck')
    for i in range(14):
        t = i/14*2*PI
        a.ellipsoid('Ruff',(0.12*math.cos(t),-0.24+0.08*math.sin(t),0.86),(0.055,0.065,0.065),ruff,'neck')
    a.ellipsoid('Bald head',(0,-0.43,1.08),(0.075,0.11,0.084),bare,'head')
    a.segment('Beak',(0,-0.49,1.055),(0,-0.63,1.035),0.039,beak,'head')
    a.segment('Hook',(0,-0.625,1.046),(0,-0.635,0.994),0.02,beak,'head')
    for s in [-1,1]:
        a.ellipsoid('Eye',(s*0.067,-0.47,1.102),(0.013,0.022,0.017),eye,'head')
        a.bone('leg'+str(s),(s*0.13,0.14,0.49),(s*0.15,0.17,0.2),'hips')
        a.bone('foot'+str(s),(s*0.15,0.17,0.2),(s*0.15,0.07,0.045),'leg'+str(s))
        a.segment('Thigh',(s*0.13,0.14,0.47),(s*0.15,0.17,0.22),0.06,brown,'leg'+str(s))
        a.segment('Shin',(s*0.15,0.17,0.22),(s*0.15,0.08,0.052),0.023,bare,'foot'+str(s))
        for d in range(3):
            a.segment('Toe',(s*0.15,0.08,0.047),(s*0.15+(d-1)*0.045,-0.09,0.026),0.011,beak,'foot'+str(s))
        a.bone('wing'+str(s),(s*0.16,-0.05,0.78),(s*0.67,0.04,0.77),'hips')
        a.bone('tip'+str(s),(s*0.67,0.04,0.77),(s*1.27,0.14,0.75),'wing'+str(s))
        a.segment('Wing coverts',(s*0.2,0,0.78),(s*0.7,0.06,0.77),0.14,brown,'wing'+str(s),0.065)
        for i in range(12):
            x = 0.24+i*0.085
            b = 'wing'+str(s) if i<5 else 'tip'+str(s)
            start = (s*x,0.0+i*0.008,0.775)
            end = (s*(x+0.075),0.44+0.17*math.sin(i/12*PI),0.73)
            a.segment('Primary' if i>5 else 'Secondary',start,end,0.053,wing if i>5 else edges,b,0.018)
            a.segment('Shaft',start,end,0.003,brown,b)
        for i in range(6):
            a.segment('Tail feather',(s*0.015*i,0.3,0.65),(s*(0.018+i*0.027),0.68,0.48),0.039,wing,'hips',0.017)
    a.skin()
    def folded():
        for s in [-1,1]:
            a.pose('wing'+str(s),(0,0,1),s*1.2)
            a.pose('wing'+str(s),(0,1,0),s*0.45)
            a.pose('tip'+str(s),(0,0,1),-s*0.45)
    def idle(t):
        folded(); a.pose('head',(0,0,1),math.sin(t*2*PI)*0.14)
    def walk(t):
        idle(t)
        for s in [-1,1]:
            a.pose('leg'+str(s),(1,0,0),math.sin(t*2*PI+s*PI/2)*0.25)
            a.pose('foot'+str(s),(1,0,0),-math.sin(t*2*PI+s*PI/2)*0.17)
    def fly(t,flap=True):
        for s in [-1,1]:
            a.pose('wing'+str(s),(0,1,0),s*(0.08+math.sin(t*2*PI)*(0.42 if flap else 0.025)))
            a.pose('tip'+str(s),(0,1,0),s*math.sin(t*2*PI-0.4)*(0.18 if flap else 0.01))
            a.pose('leg'+str(s),(1,0,0),0.6)
    def feed(t):
        folded(); a.pose('neck',(1,0,0),0.8+math.sin(t*4*PI)*0.12)
        a.pose('head',(1,0,0),0.65)
    def death(t):
        folded(); s=min(1,t*1.4); a.pose('root',(0,1,0),s*1.4)
        a.root_offset(z=0.24*s)
    for name,seconds,fn in [('Idle',3,idle),('Walk',1.2,walk),('Flap',1,fly),('Glide',3,lambda t:fly(t,False)),
                            ('Eating',2,feed),('Drinking',2,feed),('Resting',4,idle),('Death',2,death)]:
        a.animate(name,seconds,fn)
    a.export()


if __name__ == '__main__':
    for name in ['Langur','Squirrel','Hare']:
        mammal(name)
    vulture()
