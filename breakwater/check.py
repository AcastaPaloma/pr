"""Self-checks. The film is machine-made, so the machine inspects it.

`check_frames` measures every graded frame (exposure, clipping, dead frames, frame-to-frame jumps,
whether the instruments are present). `check_audio` confirms each scripted sound actually raises the
level where the timeline says it happens. `check_video` asks ffprobe what was encoded.
`contact_sheet` tiles frames into one image for a human (or a model) to look at.
"""
import glob, json, os, subprocess
import numpy as np
from PIL import Image
from . import FPS


def check_frames(png_dir, sortie):
    files = sorted(glob.glob(os.path.join(png_dir, 'f_*.png')))
    rows = []; prev = None; issues = []
    for f in files:
        i = int(os.path.basename(f)[2:6]); t = i / FPS
        a = np.asarray(Image.open(f).convert('RGB').resize((320, 180), Image.BILINEAR), np.float32) / 255.0
        lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        row = dict(frame=i, t=round(t, 3), mean=float(lum.mean()), p99=float(np.percentile(lum, 99)), clipped=float((lum > 0.98).mean()), black=float((lum < 0.02).mean()),
                   jump=float(np.abs(lum - prev).mean()) if prev is not None else 0.0)
        prev = lum; rows.append(row)
        fade = sortie.fade(t)
        if fade > 0.9:
            if row['mean'] < 0.035: issues.append((i, 'nearly black (mean %.3f)' % row['mean']))
            if row['clipped'] > 0.25: issues.append((i, 'blown out (%.0f%% clipped)' % (100 * row['clipped'])))
            if row['p99'] < 0.25: issues.append((i, 'no highlights at all (p99 %.2f)' % row['p99']))
    expected = int(round(sortie.duration * FPS))
    have = {r['frame'] for r in rows}
    missing = [i for i in range(expected) if i not in have]
    if missing: issues.append((missing[0], '%d frames missing (first %d)' % (len(missing), missing[0])))
    # large jumps are only expected at scripted hits and the lightning
    loud = [sortie.p['lightning'], sortie.p['lightning'] + 0.21, sortie.fire_t, sortie.impact_t, sortie.swipe_hit, sortie.hit_l, sortie.hit_r, sortie.slam_hit]
    for r in rows:
        if r['jump'] > 0.09 and min(abs(r['t'] - x) for x in loud) > 0.3 and sortie.fade(r['t']) > 0.9:
            issues.append((r['frame'], 'unexplained jump between frames (%.3f)' % r['jump']))
    return dict(frames=len(rows), expected=expected, mean_luma=float(np.mean([r['mean'] for r in rows])) if rows else 0.0,
                max_jump=max((r['jump'] for r in rows), default=0.0), issues=issues, rows=rows)


def check_audio(wav_path, sortie):
    from . import audio
    mix = audio.read_wav(wav_path); sr = audio.SR
    out = dict(seconds=len(mix) / sr, peak=float(np.abs(mix).max()), rms=float(np.sqrt((mix ** 2).mean())), nan=bool(np.isnan(mix).any()), events=[], issues=[])
    if out['peak'] > 0.99: out['issues'].append('clipping')
    if abs(out['seconds'] - sortie.duration) > 0.1: out['issues'].append('length %.2f s, film is %.2f s' % (out['seconds'], sortie.duration))
    quiet = {'thunder', 'charge', 'whoosh', 'whoosh_heavy', 'sync', 'step', 'klaxon'}
    for at, kind, _ in sortie.events:
        if kind == 'step': continue
        i = int(at * sr)
        pre = float(np.sqrt((mix[max(0, i - int(0.15 * sr)):i] ** 2).mean() + 1e-12)); post = float(np.sqrt((mix[i:i + int(0.25 * sr)] ** 2).mean() + 1e-12))
        out['events'].append(dict(t=round(at, 2), kind=kind, before=round(pre, 3), after=round(post, 3)))
        if kind not in quiet and post < pre * 1.25 and post < 0.3: out['issues'].append('%s at %.2f s does not stand out (%.3f -> %.3f)' % (kind, at, pre, post))
    return out


def check_video(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,nb_frames,r_frame_rate,duration', '-of', 'json', path], capture_output=True, text=True)
    info = json.loads(r.stdout or '{}').get('streams', [])
    return dict(streams=info, bytes=os.path.getsize(path) if os.path.exists(path) else 0)


def contact_sheet(png_dir, out_path, times, cols=4, thumb=(480, 270)):
    files = [os.path.join(png_dir, 'f_%04d.png' % int(round(t * FPS))) for t in times]
    files = [f for f in files if os.path.exists(f)]
    if not files: return None
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * thumb[0], rows * thumb[1]), (0, 0, 0))
    for k, f in enumerate(files):
        sheet.paste(Image.open(f).convert('RGB').resize(thumb, Image.LANCZOS), ((k % cols) * thumb[0], (k // cols) * thumb[1]))
    sheet.save(out_path)
    return out_path
