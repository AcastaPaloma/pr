"""python -m breakwater <command> --out DIR

  render   path-trace frames with Blender Cycles (needs the `bpy` module)        -> DIR/exr/f_####.exr + .json
  post     denoise, haze, particles, lens, instruments (NumPy only)             -> DIR/png/f_####.png
  audio    synthesise the soundtrack                                            -> DIR/audio.wav
  mux      encode with ffmpeg                                                   -> DIR/breakwater.mp4
  check    measure the result and write DIR/report.json + DIR/contact.png
  still    one finished frame at --t seconds                                    -> DIR/still_<t>.png
  all      render, post, audio, mux, check

Options: --script file.json (override beat times/positions, see timeline.DEFAULT), --size 960x540,
--samples 16, --start/--end (frame range), --follow (post: keep waiting for frames from a running render).
"""
import argparse, glob, json, os, subprocess, sys, time
import numpy as np
from . import FPS


def _sortie(args):
    from .timeline import Sortie
    script = json.load(open(args.script)) if args.script else None
    try:
        from .mech import Mech
        from .creature import Creature
        return Sortie(script, getattr(Mech, 'DUR', None), getattr(Creature, 'DUR', None))
    except ImportError:                              # no Blender in this interpreter: the default timings still apply
        return Sortie(script)


def cmd_render(args, s):
    from .scene import Film
    w, h = map(int, args.size.split('x'))
    os.makedirs(os.path.join(args.out, 'exr'), exist_ok=True)
    film = Film(s, w, h, args.samples)
    n = int(round(s.duration * FPS)); a = args.start or 0; b = min(args.end or n, n)
    t0 = time.time(); done = 0
    for i in range(a, b):
        secs = film.render_frame(i, os.path.join(args.out, 'exr'))
        if secs:
            done += 1
            print('frame %d/%d  %.1f s  (avg %.1f s, about %.0f min left)' % (i + 1, b, secs, (time.time() - t0) / done, (time.time() - t0) / done * (b - i - 1) / 60), flush=True)


def _post_one(args, s, i, prev, grid):
    from . import bl_exr, post
    base = os.path.join(args.out, 'exr', 'f_%04d' % i)
    meta = json.load(open(base + '.json'))
    img, keep = post.grade_frame(bl_exr.read_exr(base + '.exr'), meta, s, prev, grid)
    from PIL import Image
    os.makedirs(os.path.join(args.out, 'png'), exist_ok=True)
    Image.fromarray(img).save(os.path.join(args.out, 'png', 'f_%04d.png' % i), compress_level=3)
    return keep


def cmd_post(args, s):
    from . import world
    grid = world.terrain_mesh()[3]
    n = int(round(s.duration * FPS)); a = args.start or 0; b = min(args.end or n, n)
    prev = None; i = a; idle = 0
    while i < b:
        base = os.path.join(args.out, 'exr', 'f_%04d' % i)
        if not (os.path.exists(base + '.exr') and os.path.exists(base + '.json')):
            if not args.follow or idle > 900: print('stopping at frame %d: not rendered' % i); break
            time.sleep(2); idle += 2; continue
        idle = 0; t0 = time.time()
        prev = _post_one(args, s, i, prev, grid)
        if not args.keep_exr and i > a: 
            old = os.path.join(args.out, 'exr', 'f_%04d.exr' % (i - 1))
            if args.follow and os.path.exists(old): os.remove(old)           # EXRs are large; drop them once graded
        print('post %d/%d  %.1f s' % (i + 1, b, time.time() - t0), flush=True)
        i += 1


def cmd_audio(args, s):
    from . import audio
    os.makedirs(args.out, exist_ok=True)
    mix, _ = audio.render(s)
    audio.write_wav(os.path.join(args.out, 'audio.wav'), mix)
    print('audio %.2f s, peak %.2f' % (len(mix) / audio.SR, np.abs(mix).max()))


def cmd_mux(args, s):
    out = os.path.join(args.out, 'breakwater.mp4')
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(args.out, 'png', 'f_%04d.png'), '-i', os.path.join(args.out, 'audio.wav'),
           '-c:v', 'libx264', '-preset', 'slow', '-crf', str(args.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k', '-shortest', out]
    subprocess.run(cmd, check=True)
    print('wrote', out, '%.1f MB' % (os.path.getsize(out) / 1e6))


def cmd_check(args, s):
    from . import check
    rep = dict(frames=check.check_frames(os.path.join(args.out, 'png'), s))
    wav = os.path.join(args.out, 'audio.wav'); mp4 = os.path.join(args.out, 'breakwater.mp4')
    if os.path.exists(wav): rep['audio'] = check.check_audio(wav, s)
    if os.path.exists(mp4): rep['video'] = check.check_video(mp4)
    times = [0.6, 1.9, 3.2, 4.2, 5.4, 7.0, 9.4, 10.2, 10.5, 12.0, 13.6, 14.05, 14.56, 15.21, 16.05, 17.0, 17.9, 19.0, 20.2, 21.0]
    rep['contact_sheet'] = check.contact_sheet(os.path.join(args.out, 'png'), os.path.join(args.out, 'contact.png'), times)
    rows = rep['frames'].pop('rows')
    json.dump(dict(rep, per_frame=rows), open(os.path.join(args.out, 'report.json'), 'w'), indent=1)
    print(json.dumps(rep, indent=1)[:6000])
    bad = len(rep['frames']['issues']) + len(rep.get('audio', {}).get('issues', []))
    print('CHECK', 'PASSED' if not bad else 'FOUND %d ISSUES' % bad)
    return bad


def cmd_still(args, s):
    from .scene import Film
    from . import bl, post, world
    from PIL import Image
    w, h = map(int, args.size.split('x'))
    film = Film(s, w, h, args.samples)
    grid = film.world['height_grid']
    os.makedirs(args.out, exist_ok=True)
    for t in args.t:
        meta = film.set_time(t); t0 = time.time()
        exr = bl.render(os.path.join(args.out, 'tmp_still')); rs = time.time() - t0; t0 = time.time()
        img, _ = post.grade_frame(bl.read_exr(exr), meta, s, None, grid)
        path = os.path.join(args.out, 'still_%05.2f.png' % t); Image.fromarray(img).save(path)
        print('still t=%.2f  render %.1f s  post %.1f s  -> %s' % (t, rs, time.time() - t0, path), flush=True)
        os.remove(exr)


def main():
    ap = argparse.ArgumentParser(prog='python -m breakwater', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['render', 'post', 'audio', 'mux', 'check', 'still', 'all'])
    ap.add_argument('--out', default='out'); ap.add_argument('--script'); ap.add_argument('--size', default='960x540'); ap.add_argument('--samples', type=int, default=16)
    ap.add_argument('--start', type=int); ap.add_argument('--end', type=int); ap.add_argument('--follow', action='store_true'); ap.add_argument('--keep-exr', action='store_true')
    ap.add_argument('--t', type=float, nargs='*', default=[10.3]); ap.add_argument('--crf', type=int, default=19)
    args = ap.parse_args()
    s = _sortie(args)
    if args.command == 'all':
        cmd_render(args, s); cmd_post(args, s); cmd_audio(args, s); cmd_mux(args, s); sys.exit(1 if cmd_check(args, s) else 0)
    r = {'render': cmd_render, 'post': cmd_post, 'audio': cmd_audio, 'mux': cmd_mux, 'check': cmd_check, 'still': cmd_still}[args.command](args, s)
    sys.exit(1 if (args.command == 'check' and r) else 0)


if __name__ == '__main__':
    main()
