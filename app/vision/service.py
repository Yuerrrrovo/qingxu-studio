# -*- coding: utf-8 -*-
"""Local-only Reformer analysis. No cloud calls, credentials, or frame storage."""
import base64
import binascii
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import cv2
import mediapipe as mp
import numpy as np
from reformer_engine import ReformerActionEngine
from reformer_reference import ReformerReferenceTracker
from camera_source import SOURCE, CameraError

ROOT = Path(__file__).resolve().parent
POSE_COMPLEXITY = 0 if (Path(mp.__file__).resolve().parent / "modules/pose_landmark/pose_landmark_lite.tflite").is_file() else 1
ACTIONS = {"footwork", "feet_in_straps", "pelvic_curl", "short_box", "chest_expansion"}
LANDMARKS = mp.solutions.pose.PoseLandmark


class Session:
    def __init__(self, action):
        self.action = action
        self.engine = ReformerActionEngine()
        self.engine.set_action(action)
        self.reference = ReformerReferenceTracker()
        self.pose = mp.solutions.pose.Pose(model_complexity=POSE_COMPLEXITY, min_detection_confidence=.5,
                                            min_tracking_confidence=.5, static_image_mode=False)
        self.last_seen = time.monotonic()

    def close(self):
        self.pose.close()


class Analyzer:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()

    def _session(self, sid, action):
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", sid or "") or action not in ACTIONS:
            raise ValueError("训练会话或动作无效；请先选择具体 Reformer 动作")
        now = time.monotonic()
        for key in [k for k, s in self.sessions.items() if now-s.last_seen > 1800]:
            self.sessions.pop(key).close()
        if sid not in self.sessions:
            if len(self.sessions) >= 2:
                raise ValueError("本机分析会话已满，请关闭其他训练页面")
            self.sessions[sid] = Session(action)
        session = self.sessions[sid]
        if session.action != action:
            raise ValueError("动作已变化，请开始新的训练会话")
        session.last_seen = now
        return session

    @staticmethod
    def decode(data):
        if not isinstance(data, dict) or data.get("mime") != "image/jpeg" or not isinstance(data.get("data"), str):
            raise ValueError("请提供 JPEG 取样帧")
        try:
            raw = base64.b64decode(data["data"], validate=True)
            array = np.frombuffer(raw, np.uint8)
            image = cv2.imdecode(array, cv2.IMREAD_COLOR)
        except (ValueError, binascii.Error):
            image = None
        if image is None or max(image.shape[:2]) > 640:
            raise ValueError("取样帧须为不超过 640px 的有效 JPEG")
        return image

    def calibrate(self, body):
        points = body.get("points")
        if (not isinstance(points, list) or len(points) != 3 or
                any(not isinstance(p, list) or len(p) != 2 or
                    any(not isinstance(v, (int, float)) or isinstance(v, bool) or not np.isfinite(v) for v in p)
                    for p in points)):
            raise ValueError("请依次选择床架固定点 A、B 和滑车点 C")
        image = self.decode(body.get("frame"))
        with self.lock:
            session = self._session(body.get("session_id"), body.get("exercise"))
            session.reference.calibrate(image, points)
            session.engine.reset_session()
            return {"calibrated": True, "message": "床架与滑车标定成功；完成完整动作后才会评分"}

    @staticmethod
    def _landmarks(results, width, height):
        if not results.pose_landmarks:
            raise ValueError("未检测到完整人体，暂不评分")
        points = results.pose_landmarks.landmark

        def point(name):
            p = points[getattr(LANDMARKS, name)]
            return (p.x*width, p.y*height), float(p.visibility)

        left = sum(point(n)[1] for n in ("LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST", "LEFT_HIP", "LEFT_KNEE", "LEFT_ANKLE"))
        right = sum(point(n)[1] for n in ("RIGHT_SHOULDER", "RIGHT_ELBOW", "RIGHT_WRIST", "RIGHT_HIP", "RIGHT_KNEE", "RIGHT_ANKLE"))
        prefix = "LEFT" if left >= right else "RIGHT"
        other = "RIGHT" if prefix == "LEFT" else "LEFT"
        names = {"ear": "EAR", "shoulder": "SHOULDER", "elbow": "ELBOW", "wrist": "WRIST",
                 "hip": "HIP", "knee": "KNEE", "ankle": "ANKLE"}
        output, visibility = {}, {}
        for key, suffix in names.items():
            output[key], visibility[key] = point(prefix+"_"+suffix)
        for key, suffix in (("other_hip", "HIP"), ("other_knee", "KNEE"), ("other_ankle", "ANKLE")):
            output[key], visibility[key] = point(other+"_"+suffix)
        for key, (x, y) in output.items():
            if not (-.02*width <= x <= 1.02*width and -.02*height <= y <= 1.02*height):
                visibility[key] = 0
        ls, _ = point("LEFT_SHOULDER")
        rs, _ = point("RIGHT_SHOULDER")
        lh, _ = point("LEFT_HIP")
        rh, _ = point("RIGHT_HIP")
        sh = np.array(output["shoulder"])
        hp = np.array(output["hip"])
        torso = max(1., float(np.linalg.norm(sh-hp)))
        side_view = (np.linalg.norm(np.array(ls)-rs)/torso < .55 and
                     np.linalg.norm(np.array(lh)-rh)/torso < .55)
        nose, nose_visibility = point("NOSE")
        ear = np.array(output["ear"])
        face_dx = nose[0]-ear[0]
        direction = None
        if nose_visibility >= .6 and visibility["ear"] >= .6 and abs(face_dx) > .05*torso:
            direction = 1 if face_dx > 0 else -1
        return output, visibility, side_view, direction

    def analyze(self, body):
        image = self.decode(body.get("frame"))
        elapsed = body.get("elapsed_seconds")
        if not isinstance(elapsed, (int, float)) or isinstance(elapsed, bool) or not np.isfinite(elapsed):
            raise ValueError("源时间无效")
        with self.lock:
            session = self._session(body.get("session_id"), body.get("exercise"))
            context = session.reference.update(image)
            previous_timestamp = session.engine.last_timestamp
            source_gap = previous_timestamp is not None and float(elapsed)-previous_timestamp > .5
            results = session.pose.process(cv2.cvtColor(cv2.resize(image, (min(360, image.shape[1]), round(image.shape[0]*min(360, image.shape[1])/image.shape[1]))), cv2.COLOR_BGR2RGB))
            try:
                if source_gap:
                    raise ValueError("取样间隔超过 0.5 秒，当前动作已中断，暂不评分；请检查本机性能与画面采集速度")
                points, visibility, side_view, direction = self._landmarks(results, *image.shape[:2][::-1])
                context["view_valid"] = side_view
                context["facing_direction"] = direction
                if context.get("reference_valid"):
                    points = {key: session.reference.transform(value) for key, value in points.items()}
                telemetry = session.engine.process_landmarks(points, image.shape[1], image.shape[0],
                    timestamp=float(elapsed), coordinate_space="pixels", visibility=visibility,
                    measurement_context=context)
                state = telemetry.get("state", "IDLE")
                telemetry["live_coaching"] = {"state": state, "live_cue": telemetry.get("live_cue", ""), "observation_valid": telemetry.get("observation_valid", False)}
                if not telemetry.get("observation_valid"):
                    telemetry["live_cue"] = telemetry.get("quality_message") or "当前画面不足以判断，暂不评分。"
                elif telemetry.get("alerts"):
                    telemetry["live_cue"] = "已观测到超过设定阈值的指标，请减慢动作并复核机位、标定与动作控制。"
                elif session.action == "footwork":
                    telemetry["live_cue"] = "推蹬时保留膝关节控制；回程匀速减速，避免末端冲击。"
                elif session.action == "feet_in_straps":
                    telemetry["live_cue"] = "保持骨盆稳定，按自身控制范围完成腿部动作。"
                elif session.action == "pelvic_curl":
                    telemetry["live_cue"] = "缓慢抬髋与回落，保持滑车稳定；二维图像不判断逐节椎骨运动。"
                elif session.action == "short_box":
                    telemetry["live_cue"] = "保持耳肩髋对齐，以髋关节为轴完成后倾与回正。"
                else:
                    telemetry["live_cue"] = "保持高跪姿与直臂控制，避免耸肩和躯干晃动。"
                telemetry["live_coaching"]["live_cue"] = telemetry["live_cue"]
            except ValueError as error:
                telemetry = session.engine.reject_observation(str(error), float(elapsed))
            payload = session.engine.export_api_payload(telemetry)
            landmarks = getattr(results, 'pose_landmarks', None)
            payload['pose'] = {'detected': landmarks is not None, 'source_gap': source_gap,
                'landmarks': [[float(np.clip(p.x, -2, 3)), float(np.clip(p.y, -2, 3)), float(np.clip(p.visibility, 0, 1))]
                              for p in landmarks.landmark] if landmarks else []}
            return payload, session.reference.valid

    def reset(self, sid):
        with self.lock:
            session = self.sessions.pop(sid, None)
        if session:
            session.close()


ANALYZER = Analyzer()
POSE_LOCK = threading.Lock()
PREVIEW_POSE = None


def preview_pose(body):
    global PREVIEW_POSE
    if body.get('consent') is not True:
        raise CameraError('请先勾选本次画面取样授权。', 403)
    image = Analyzer.decode(body.get('frame'))
    with POSE_LOCK:
        if PREVIEW_POSE is None:
            PREVIEW_POSE = mp.solutions.pose.Pose(model_complexity=POSE_COMPLEXITY, static_image_mode=True,
                                                 min_detection_confidence=.5)
        result = PREVIEW_POSE.process(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        points = getattr(result, 'pose_landmarks', None)
        return {'version': '1.0', 'pose': {'detected': points is not None, 'source_gap': False,
                'landmarks': [[float(np.clip(p.x, -2, 3)), float(np.clip(p.y, -2, 3)),
                               float(np.clip(p.visibility, 0, 1))] for p in points.landmark] if points else []}}


def old_contract(payload, sample_id, calibrated):
    score = payload["exercise_meta"]["current_repetition_score"]
    live = payload.get("live_interaction", {})
    ref = payload.get("live_coaching") or payload.get("reformer") or {}
    alerts = ref.get("alerts", [])
    observation = ref.get("observation_valid", live.get("observation_valid"))
    status = ("needs_calibration" if not calibrated else "insufficient_data" if not observation
              else payload["assessment_status"])
    complete = (status == "completed" and isinstance(score, (int, float))
                and not isinstance(score, bool) and np.isfinite(score) and 0 <= score <= 100)
    if status == "completed" and not complete:
        status = "insufficient_data"
    observations = []
    if not calibrated:
        observations.append({"kind": "uncertain", "text": "请暂停在起始姿势，依次点击床架固定点 A、B 和滑车点 C，完成三点标定。", "confidence": .9})
    elif not observation:
        observations.append({"kind": "uncertain", "text": ref.get("quality_message") or live.get("live_cue") or "需要清晰全身侧视画面，当前不评分。", "confidence": .9})
    elif not complete:
        observations.append({"kind": "uncertain", "text": live.get("live_cue") or "正在观测完整往返动作，尚未形成有效评分。", "confidence": .9})
    else:
        deductions = payload.get("hinge_loss_deductions", [])
        observations.append({"kind": "positive" if not deductions else "improve",
            "text": f"第 {payload['exercise_meta']['repetition_index']} 次二维筛查：{score:.1f} 分。" + ("；".join(d["fault_desc_cn"] for d in deductions) if deductions else "已观测指标未越过设定阈值。"),
            "confidence": .9})
    if live.get("live_cue") and not any(o["text"] == live["live_cue"] for o in observations):
        observations.append({"kind": "improve" if alerts else "uncertain", "text": live["live_cue"], "confidence": .9})
    return {"version": "1.0", "sample_id": sample_id, "observations": observations[:8],
            **({'pose': payload['pose']} if 'pose' in payload else {}),
            "safety": "none", "safety_reason": "", "repetition_count": payload["exercise_meta"]["repetition_index"],
            "reformer": {"assessment_status": status, "score": score if complete else None,
                         "calibrated": calibrated, "state": live.get("state"),
                         "deductions": payload.get("hinge_loss_deductions", []) if complete else [],
                         "missing_measurements": payload.get("missing_measurements", [])}}


class Handler(BaseHTTPRequestHandler):
    server_version = "QingxuReformer/1.0"

    def log_message(self, *_):
        pass

    def json_response(self, status, body):
        if body.get("observations") and isinstance(body.get("reformer"), dict):
            body["reformer"]["live_cue"] = next((o["text"] for o in body["observations"] if o["kind"] != "uncertain"), body["observations"][0]["text"])
        raw = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        try:
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # The member cancelled or left the page.

    def do_GET(self):
        if self.path == "/health":
            self.json_response(200, {"ready": True, "actions": sorted(ACTIONS), "camera_source": True, "pose_preview": True, "privacy": "local_no_frame_storage"})
        else:
            self.json_response(404, {"error": "not_found"})

    def do_POST(self):
        try:
            expected = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != expected or self.headers.get("Origin") not in (None, f"http://{expected}"):
                return self.json_response(403, {"error": "origin_rejected"})
            if self.headers.get("X-Qingxu-Vision") != "local-reformer-v1":
                return self.json_response(403, {"error": "origin_rejected"})
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 400000:
                return self.json_response(413, {"error": "payload_too_large"})
            body = json.loads(self.rfile.read(length))
            if self.path == '/camera/start':
                return self.json_response(200, SOURCE.start(body.get('camera_id'), body.get('url')))
            if self.path == '/camera/frame':
                return self.json_response(200, SOURCE.frame(body.get('camera_id')))
            if self.path == '/camera/stop':
                return self.json_response(200, SOURCE.stop(body.get('camera_id')))
            if self.path == '/camera/pose':
                return self.json_response(200, preview_pose(body))
            if self.path == "/calibrate":
                return self.json_response(200, ANALYZER.calibrate(body))
            if self.path == "/analyze":
                payload, calibrated = ANALYZER.analyze(body)
                return self.json_response(200, old_contract(payload, str(body.get("sample_id", ""))[:80], calibrated))
            if self.path == "/reset":
                ANALYZER.reset(str(body.get("session_id", ""))[:80])
                return self.json_response(200, {"reset": True})
            self.json_response(404, {"error": "not_found"})
        except CameraError as error:
            self.json_response(error.status, {'error': {'message': str(error)}})
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.json_response(400, {"error": "invalid_request", "message": str(error)[:300]})
        except Exception:
            self.json_response(500, {"error": "analysis_failed", "message": "本机视觉分析未完成，请检查侧视画面与标定。"})


if __name__ == "__main__":
    port = int(os.environ.get("QINGXU_VISION_PORT", "4185"))
    if not 1024 <= port <= 65535:
        raise ValueError("Invalid port")
    print(f"青序 Reformer 本机视觉服务：http://127.0.0.1:{port}（不联网、不保存画面）", flush=True)
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    finally:
        with ANALYZER.lock:
            for session in ANALYZER.sessions.values():
                session.close()
            ANALYZER.sessions.clear()
