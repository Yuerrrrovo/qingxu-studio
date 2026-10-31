# -*- coding: utf-8 -*-
"""Headless, source-time Reformer screening. Coordinates are pixels in a bed-aligned frame.

Scores describe the configured 2-D checks, not tissue loading or clinical diagnosis.
An actual carriage observation and a tracked bed reference are required where applicable.
"""
import copy
import math
import time
from dataclasses import dataclass
import numpy as np


@dataclass(frozen=True)
class MetricRule:
    metric: str
    safe: float
    critical: float
    points_at_critical: float
    description: str
    severity: str = "SERIOUS"
    lower_is_bad: bool = False

    def loss(self, value):
        delta = self.safe - value if self.lower_is_bad else value - self.safe
        return self.points_at_critical * max(0.0, delta) / abs(self.critical - self.safe)


# Acceptance thresholds come from the integration specification. Weights are explicit
# engineering settings, not empirically validated injury probabilities.
ACTION_RULES = {
    "footwork": (
        MetricRule("max_knee_ext", 175, 178.5, 20, "末端伸膝超过设定阈值", "CRITICAL"),
        MetricRule("min_peak_knee_ext", 168, 145, 12, "双腿推蹬伸展幅度不足", lower_is_bad=True),
        MetricRule("peak_return_speed", .40, .75, 18, "离心末端回程速度过快", "CRITICAL"),
    ),
    "feet_in_straps": (
        MetricRule("min_leg_angle", 40, 28, 20, "双腿下沉角度过低", lower_is_bad=True),
        MetricRule("pelvis_displacement", .04, .10, 15, "骨盆垂向位移超过阈值"),
    ),
    "pelvic_curl": (
        MetricRule("peak_bridge_angle", 162, 145, 15, "桥式顶峰伸展不足", lower_is_bad=True),
        MetricRule("carriage_shift", .03, .08, 25, "桥式滑车移位", "CRITICAL"),
    ),
    "short_box": (
        MetricRule("max_spine_res", .045, .080, 20, "脊柱平背共线残差过大"),
        MetricRule("neck_compression", .15, .30, 12, "耳肩距离压缩过大"),
    ),
    "chest_expansion": (
        MetricRule("max_alignment_tilt", 8, 16, 18, "耳肩髋膝铅垂对齐偏差"),
        MetricRule("max_sh_ext", 85, 40, 20, "肩后伸幅度不足", lower_is_bad=True),
        MetricRule("min_elbow_ext", 155, 135, 15, "拉绳屈肘代偿", lower_is_bad=True),
        MetricRule("torso_sway", 12, 24, 15, "躯干周期晃动过大"),
        MetricRule("neck_compression", .15, .30, 12, "耸肩导致耳肩距离压缩"),
    ),
}


class KinematicRingBuffer:
    """Recent signal samples only. Whole-repetition extrema use RunningRange."""
    def __init__(self, capacity=60):
        self.capacity = capacity
        self.data = np.zeros(capacity, dtype=np.float64)
        self.ptr = self.size = 0
    def push(self, value):
        self.data[self.ptr] = value
        self.ptr = (self.ptr + 1) % self.capacity
        self.size = min(self.size + 1, self.capacity)
    def get_latest(self, offset=0):
        return float(self.data[(self.ptr - 1 - offset) % self.capacity]) if 0 <= offset < self.size else 0.0
    def get_range(self):
        return float(np.ptp(self.data[:self.size])) if self.size else 0.0
    def get_std(self):
        return float(np.std(self.data[:self.size])) if self.size else 0.0
    def clear(self):
        self.data.fill(0)
        self.ptr = self.size = 0


class RunningRange:
    def __init__(self):
        self.minimum = math.inf
        self.maximum = -math.inf
    def push(self, value):
        self.minimum = min(self.minimum, float(value))
        self.maximum = max(self.maximum, float(value))
    def get_range(self):
        return max(0.0, self.maximum - self.minimum) if math.isfinite(self.minimum) else 0.0
    def clear(self):
        self.__init__()


class BiomechanicsMath:
    @staticmethod
    def angle_2d(p1, vertex, p2):
        a, b = np.asarray(p1) - vertex, np.asarray(p2) - vertex
        norm = float(np.linalg.norm(a) * np.linalg.norm(b))
        if norm < 1e-8:
            raise ValueError("重合关节点不能定义关节角")
        return math.degrees(math.acos(float(np.clip(np.dot(a, b) / norm, -1, 1))))
    @staticmethod
    def plumbline_tilt(top, bottom):
        return abs(BiomechanicsMath.signed_tilt(top, bottom))
    @staticmethod
    def signed_tilt(top, bottom):
        dx, dy = bottom[0] - top[0], bottom[1] - top[1]
        if math.hypot(dx, dy) < 1e-8:
            raise ValueError("重合关节点不能定义铅垂角")
        return math.degrees(math.atan2(dx, max(abs(dy), 1e-8)))
    @staticmethod
    def colinearity_residual(p1, p2, p3):
        v = np.asarray(p3) - p1
        norm = float(np.linalg.norm(v))
        if norm < 1e-8:
            raise ValueError("重合参考点不能定义共线残差")
        r = np.asarray(p2) - p1
        return abs(v[0] * r[1] - v[1] * r[0]) / norm
    @staticmethod
    def hinge_loss(val, safe_thresh, crit_thresh, invert=False):
        """Uncapped linear hinge, compatible with the specification's w * excess."""
        span = abs(crit_thresh - safe_thresh)
        if span <= 0:
            raise ValueError("safe 和 critical 阈值不能相等")
        return max(0.0, safe_thresh - val if invert else val - safe_thresh) / span
    @staticmethod
    def knee_extension(hip, knee, ankle):
        angle = BiomechanicsMath.angle_2d(hip, knee, ankle)
        # In supine side view, knee below the hip-ankle chord is a signed
        # extension beyond 180. Mirroring the camera preserves the result.
        v, r = np.asarray(ankle) - hip, np.asarray(knee) - hip
        offset = (v[0] * r[1] - v[1] * r[0]) * (1 if v[0] >= 0 else -1)
        return 360 - angle if abs(v[0]) > .3 * np.linalg.norm(v) and offset > 1e-5 else angle


class BaseReformerAction:
    REQUIRED_POINTS = ("shoulder", "hip", "knee", "ankle")
    REQUIRES_REFERENCE = True
    REQUIRES_CARRIAGE = False
    def __init__(self, key, name_cn, prompt_concept):
        self.key, self.name_cn, self.prompt_concept = key, name_cn, prompt_concept
        self.state = "IDLE"
        self.rep_count = 0
        self.current_score = None
        self.penalties = []
        self.alerts = []
        self.last_rep_diagnosis = "尚无完整有效动作，暂不评分。"
        self.last_completed = None
        self.completed_repetitions = []
        self.active_rep = False
        self.elapsed = 0.0
        self.samples = 0
        self.last_metrics = {}
        self.context = {}
        self.missing = set()
    def reset_rep_metrics(self):
        """Reset only the in-progress observations; preserve completed results."""
        self.elapsed = 0.0
        self.samples = 0
        self.missing = set()
        self.last_metrics = {}
    def abort_rep(self):
        self.active_rep = False
        self.state = "IDLE"
        self.reset_rep_metrics()
        if hasattr(self, "previous_carriage"):
            self.previous_carriage = None
            self.previous_angle = None
    def _begin(self):
        self.reset_rep_metrics()
        self.active_rep = True
    def _observe(self, metrics, dt):
        self.last_metrics = dict(metrics)
        if self.active_rep:
            self.elapsed += dt
            self.samples += 1
            if self.REQUIRES_REFERENCE and not self.context.get("reference_valid"):
                self.missing.add("bed_reference")
            if self.REQUIRES_CARRIAGE and not self.context.get("carriage_valid"):
                self.missing.add("carriage_tracking")
            if self.key in ("short_box", "chest_expansion") and not self.context.get("facing_direction"):
                self.missing.add("facing_direction")
            if self.key in ("footwork", "feet_in_straps") and not self.context.get("secondary_valid"):
                self.missing.add("second_leg")
    def _score(self, metrics):
        deductions = []
        for rule in ACTION_RULES[self.key]:
            value = metrics.get(rule.metric)
            if value is not None:
                pts = rule.loss(float(value))
                if pts > 1e-7:
                    deductions.append({"metric": rule.metric, "actual": round(float(value), 5),
                                       "safe_threshold": rule.safe, "fault_desc_cn": rule.description,
                                       "penalty_points": round(pts, 4), "severity": rule.severity})
        # Rounded deductions are authoritative, so exported scores always reconcile.
        score = round(max(0.0, 100 - sum(d["penalty_points"] for d in deductions)), 4)
        return score, deductions
    def _finish(self, metrics):
        if self.elapsed < .30 or self.samples < 5:
            self.active_rep = False
            return
        self.rep_count += 1
        observed_score, deductions = self._score(metrics)
        complete = not self.missing
        self.current_score = observed_score if complete else None
        self.penalties = [(d["fault_desc_cn"], d["penalty_points"]) for d in deductions]
        self.last_completed = {
            "repetition_index": self.rep_count, "score": self.current_score,
            "observed_score": observed_score, "deductions": deductions,
            "metrics": copy.deepcopy(metrics), "missing_measurements": sorted(self.missing),
            "assessment_status": "completed" if complete else ("needs_calibration" if self.missing & {"bed_reference", "carriage_tracking", "facing_direction"} else "insufficient_data"),
            "source_timestamp": self.context.get("timestamp"), "duration_seconds": round(self.elapsed, 3),
        }
        self.completed_repetitions.append(copy.deepcopy(self.last_completed))
        details = "；".join(d["fault_desc_cn"] for d in deductions) or "已观测指标未越过设定阈值"
        rating = f"{self.current_score:.1f}分" if complete else "待标定，暂不出具总分"
        self.last_rep_diagnosis = f"【{self.name_cn}】第 {self.rep_count} 次：{rating}；{details}"
        self.active_rep = False
    def _live_alerts(self, metrics, include_peak=False):
        self.alerts = []
        for rule in ACTION_RULES[self.key]:
            if rule.lower_is_bad and not include_peak:
                continue  # An extension target is assessed at the peak, not at rest.
            value = metrics.get(rule.metric)
            if value is not None and rule.loss(value) > 1e-7:
                self.alerts.append(f"{rule.description} ({value:.3f})")


class FootworkAnalyzer(BaseReformerAction):
    REQUIRES_CARRIAGE = True
    def __init__(self):
        super().__init__("footwork", "Footwork 足部推蹬", "末端伸膝、推蹬幅度与离心回程速度筛查")
        self.reset_rep_metrics()
        self.previous_angle = None
        self.previous_carriage = None
        self.rest_carriage = None
        self.foot_origin = None
    def reset_rep_metrics(self):
        super().reset_rep_metrics()
        self.max_knee_ext = 0.0
        self.primary_peak = self.secondary_peak = 0.0
        self.peak_impact_v = 0.0
        self.slam_detected = False
        self.carriage_range = RunningRange()
        self.foot_motion = 0.0
    def update(self, kpts, l_torso, dt):
        self.context = kpts.get("_context", {})
        knee = BiomechanicsMath.knee_extension(kpts["hip"], kpts["knee"], kpts["ankle"])
        other = (BiomechanicsMath.knee_extension(kpts["other_hip"], kpts["other_knee"], kpts["other_ankle"])
                 if self.context.get("secondary_valid") else None)
        delta = 0 if self.previous_angle is None else knee - self.previous_angle
        self.previous_angle = knee
        car = self.context.get("carriage_position")
        speed = None
        if self.context.get("carriage_valid") and car is not None:
            if self.previous_carriage is not None:
                speed = abs(car - self.previous_carriage) / l_torso / dt
            self.previous_carriage = car
        else:
            self.previous_carriage = None
        if self.state == "IDLE" and knee < 110 and (other is None or other < 110):
            self.state = "BENT"
            self.rest_carriage = car
            self.foot_origin = np.asarray(kpts["ankle"])
        elif self.state == "BENT" and knee > 112 and (other is None or other > 112):
            self._begin()
            self.state = "EXTENDING"
            if self.rest_carriage is not None:
                self.carriage_range.push(self.rest_carriage/l_torso)
        if self.active_rep:
            if car is not None and self.context.get("carriage_valid"):
                self.carriage_range.push(car/l_torso)
            if self.foot_origin is not None:
                self.foot_motion = max(self.foot_motion, float(np.linalg.norm(np.asarray(kpts["ankle"])-self.foot_origin))/l_torso)
            self.primary_peak = max(self.primary_peak, knee)
            if other is not None:
                self.secondary_peak = max(self.secondary_peak, other)
            self.max_knee_ext = max(self.primary_peak, self.secondary_peak)
            if self.state == "EXTENDING" and self.max_knee_ext >= 145:
                self.state = "EXTENDED"
            if self.state == "EXTENDED" and delta < -.6:
                self.state = "RETURNING"
            if self.state == "RETURNING" and knee < 115 and speed is not None:
                self.peak_impact_v = max(self.peak_impact_v, speed)
                self.slam_detected |= speed > .40 + 1e-7
        metrics = {"knee_angle": round(knee, 3), "v_carriage": speed,
                   "other_knee_angle": other,
                   "carriage_travel": self.carriage_range.get_range() if self.context.get("carriage_valid") else None,
                   "foot_displacement": self.foot_motion,
                   "min_peak_knee_ext": min(self.primary_peak, self.secondary_peak) if other is not None else None,
                   "max_knee_ext": self.max_knee_ext, "peak_return_speed": self.peak_impact_v if self.context.get("carriage_valid") else None,
                   "slam_detected": self.slam_detected, "carriage_source": self.context.get("carriage_source", "unavailable")}
        self._observe(metrics, dt)
        self._live_alerts({"max_knee_ext": max(knee, other or 0), "peak_return_speed": speed if self.state == "RETURNING" and knee < 115 else None})
        if self.active_rep and knee < 105 and (other is None or other < 110) and self.state == "RETURNING":
            if self.context.get("carriage_valid") and self.carriage_range.get_range() < .05:
                self.missing.add("carriage_movement_not_observed")
            if self.foot_motion > .08:
                self.missing.add("footbar_contact_not_stable")
            self._finish(metrics)
            self.state = "BENT"
            self.rest_carriage = car
            self.foot_origin = np.asarray(kpts["ankle"])
        elif self.active_rep and knee < 105 and self.max_knee_ext < 145:
            self.abort_rep()
            self.state = "BENT"
        return metrics


class FeetInStrapsAnalyzer(BaseReformerAction):
    def __init__(self):
        super().__init__("feet_in_straps", "Feet in Straps 双腿套绳", "腿部仰角与骨盆在床体坐标中的全周期稳定性")
        self.reset_rep_metrics()
        self.baseline_hip_y = None
        self.other_baseline_hip_y = None
        self.start_leg_angle = None
    def reset_rep_metrics(self):
        super().reset_rep_metrics()
        self.min_leg_angle = 90.0
        self.pelvis_range = RunningRange()
        self.other_pelvis_range = RunningRange()
        self.lowest_leg = 90.0
        self.pattern = None
    def update(self, kpts, l_torso, dt):
        self.context = kpts.get("_context", {})
        hip, ankle = kpts["hip"], kpts["ankle"]
        knee = BiomechanicsMath.angle_2d(hip, kpts["knee"], ankle)
        leg = math.degrees(math.atan2(hip[1] - ankle[1], abs(ankle[0] - hip[0])))
        other_leg = None
        other_knee = None
        if self.context.get("secondary_valid"):
            oh, oa = kpts["other_hip"], kpts["other_ankle"]
            other_leg = math.degrees(math.atan2(oh[1]-oa[1], abs(oa[0]-oh[0])))
            other_knee = BiomechanicsMath.angle_2d(oh, kpts["other_knee"], oa)
        worst_leg = min(leg, other_leg) if other_leg is not None else leg
        least_extended = min(knee, other_knee) if other_knee is not None else knee
        least_flexed = max(knee, other_knee) if other_knee is not None else knee
        if self.state == "IDLE":
            self.baseline_hip_y = hip[1] / l_torso
            self.other_baseline_hip_y = kpts["other_hip"][1]/l_torso if other_leg is not None else None
            if least_flexed < 110:
                self.state = "START_BENT"
            elif least_extended > 150 and worst_leg >= 55:
                self.state = "LEGS_RAISED"
                self.start_leg_angle = worst_leg
        elif self.state == "START_BENT" and least_extended > 125:
            self._begin()
            self.pattern = "frog"
            self.state = "EXTENDING_DOWN"
        elif self.state == "LEGS_RAISED" and worst_leg < self.start_leg_angle - 5:
            self._begin()
            self.pattern = "straight_lower"
            self.state = "LOWERING"
        if self.active_rep:
            self.min_leg_angle = min(self.min_leg_angle, worst_leg)
            self.pelvis_range.push(self.baseline_hip_y)
            self.pelvis_range.push(hip[1] / l_torso)
            if other_leg is not None and self.other_baseline_hip_y is not None:
                self.other_pelvis_range.push(self.other_baseline_hip_y)
                self.other_pelvis_range.push(kpts["other_hip"][1]/l_torso)
            if self.pattern == "frog":
                if self.state == "EXTENDING_DOWN" and least_extended > 155:
                    self.state = "LOWERED"
                elif self.state == "LOWERED" and least_flexed < 140:
                    self.state = "FLEXING_RETURN"
            else:
                if self.state == "LOWERING" and worst_leg > self.min_leg_angle + 4:
                    self.state = "RAISING_RETURN"
        pelvis = max(self.pelvis_range.get_range(), self.other_pelvis_range.get_range())
        metrics = {"knee_angle": knee, "leg_angle": leg, "other_leg_angle": other_leg, "min_leg_angle": self.min_leg_angle,
                   "pelvis_displacement": pelvis if self.context.get("reference_valid") else None}
        self._observe(metrics, dt)
        self._live_alerts({"min_leg_angle": worst_leg, "pelvis_displacement": metrics["pelvis_displacement"]}, include_peak=True)
        done = (self.state == "FLEXING_RETURN" and least_flexed < 110) or (self.state == "RAISING_RETURN" and worst_leg >= self.start_leg_angle - 2)
        if self.active_rep and done:
            pattern = self.pattern
            self._finish(metrics)
            self.state = "START_BENT" if pattern == "frog" else "LEGS_RAISED"
            self.baseline_hip_y = hip[1] / l_torso
            self.other_baseline_hip_y = kpts["other_hip"][1]/l_torso if other_leg is not None else None
        return metrics


class PelvicCurlAnalyzer(BaseReformerAction):
    REQUIRES_CARRIAGE = True
    def __init__(self):
        super().__init__("pelvic_curl", "Pelvic Curl 骨盆卷动", "桥式顶峰伸展与真实滑车全周期位移；不推断逐节椎骨运动")
        self.reset_rep_metrics()
        self.rest_carriage = None
        self.rest_angle = None
        self.rest_hip_y = None
    def reset_rep_metrics(self):
        super().reset_rep_metrics()
        self.peak_bridge_angle = 0.0
        self.carriage_range = RunningRange()
        self.peak_hip_lift = 0.0
    def update(self, kpts, l_torso, dt):
        self.context = kpts.get("_context", {})
        angle = BiomechanicsMath.angle_2d(kpts["shoulder"], kpts["hip"], kpts["knee"])
        car = self.context.get("carriage_position")
        if self.state == "IDLE" and angle < 135:
            self.state = "REST_SUPINE"
            self.rest_carriage = car
            self.rest_angle = angle
            self.rest_hip_y = kpts["hip"][1]
        elif self.state == "REST_SUPINE" and angle > self.rest_angle + 3:
            self._begin()
            self.state = "ROLLING_UP"
            if self.rest_carriage is not None:
                self.carriage_range.push(self.rest_carriage / l_torso)
        if self.active_rep:
            self.peak_bridge_angle = max(self.peak_bridge_angle, angle)
            self.peak_hip_lift = max(self.peak_hip_lift, (self.rest_hip_y-kpts["hip"][1])/l_torso)
            if self.context.get("carriage_valid") and car is not None:
                self.carriage_range.push(car / l_torso)
            if self.state == "ROLLING_UP" and angle > self.rest_angle + 8:
                self.state = "PEAK_BRIDGE"
            elif self.state == "PEAK_BRIDGE" and angle < self.peak_bridge_angle - 5:
                self.state = "ROLLING_DOWN"
        shift = self.carriage_range.get_range() if self.context.get("carriage_valid") else None
        metrics = {"bridge_angle": angle, "peak_bridge_angle": self.peak_bridge_angle, "carriage_shift": shift,
                   "peak_hip_lift": self.peak_hip_lift,
                   "hip_lift": (kpts["shoulder"][1] - kpts["hip"][1]) / l_torso}
        self._observe(metrics, dt)
        self._live_alerts({"carriage_shift": shift})
        if self.active_rep and self.state == "ROLLING_DOWN" and angle < self.rest_angle + 2:
            if self.peak_hip_lift < .04:
                self.missing.add("hip_lift_not_observed")
            self._finish(metrics)
            self.state = "REST_SUPINE"
            self.rest_carriage = car
        return metrics


class ShortBoxFlatBackAnalyzer(BaseReformerAction):
    REQUIRED_POINTS = ("ear", "shoulder", "hip", "knee")
    def __init__(self):
        super().__init__("short_box", "Short Box 短盒平背", "髋轴折叠、耳肩髋共线与耳肩距离压缩")
        self.reset_rep_metrics()
        self.base_ear_sh_dist = None
    def reset_rep_metrics(self):
        super().reset_rep_metrics()
        self.max_hinge_angle = 0.0
        self.max_spine_res = 0.0
        self.min_ear_sh_dist = math.inf
    def update(self, kpts, l_torso, dt):
        self.context = kpts.get("_context", {})
        ear, sh, hip = kpts["ear"], kpts["shoulder"], kpts["hip"]
        direction = self.context.get("facing_direction")
        hinge = (-direction * math.degrees(math.atan2(sh[0]-hip[0], hip[1]-sh[1]))) if direction else BiomechanicsMath.plumbline_tilt(sh, hip)
        residual = BiomechanicsMath.colinearity_residual(ear, sh, hip) / l_torso
        distance = float(np.linalg.norm(np.asarray(ear) - sh)) / l_torso
        if self.state == "IDLE" and hinge < 8:
            self.state = "UPRIGHT_NEUTRAL"
            self.base_ear_sh_dist = distance
        elif self.state == "UPRIGHT_NEUTRAL" and hinge > 12:
            self._begin()
            self.state = "HINGING_BACK"
        if self.active_rep:
            self.max_hinge_angle = max(self.max_hinge_angle, hinge)
            self.max_spine_res = max(self.max_spine_res, residual)
            self.min_ear_sh_dist = min(self.min_ear_sh_dist, distance)
            if self.state == "HINGING_BACK" and hinge >= 16:
                self.state = "PEAK_HINGE"
            elif self.state == "PEAK_HINGE" and hinge < self.max_hinge_angle - 4:
                self.state = "RETURNING_UP"
        compression = max(0, 1 - distance / self.base_ear_sh_dist) if self.base_ear_sh_dist else 0
        peak_compression = max(0, 1 - self.min_ear_sh_dist / self.base_ear_sh_dist) if self.base_ear_sh_dist and math.isfinite(self.min_ear_sh_dist) else 0
        metrics = {"hinge_angle": hinge, "spine_res": residual, "max_spine_res": self.max_spine_res,
                   "neck_compression": peak_compression, "max_hinge_angle": self.max_hinge_angle}
        self._observe(metrics, dt)
        self._live_alerts({"max_spine_res": residual, "neck_compression": compression})
        if self.active_rep and self.state == "RETURNING_UP" and hinge < 8:
            self._finish(metrics)
            self.state = "UPRIGHT_NEUTRAL"
            self.base_ear_sh_dist = distance
        return metrics


class ChestExpansionAnalyzer(BaseReformerAction):
    REQUIRED_POINTS = ("ear", "shoulder", "elbow", "wrist", "hip", "knee", "ankle")
    def __init__(self):
        super().__init__("chest_expansion", "Chest Expansion 胸部扩展", "有方向肩后伸、直臂、耳肩髋膝铅垂与周期晃动")
        self.reset_rep_metrics()
        self.base_ear_sh_dist = None
    def reset_rep_metrics(self):
        super().reset_rep_metrics()
        self.max_sh_ext = 0.0
        self.min_elbow_ext = 180.0
        self.max_alignment_tilt = 0.0
        self.tilt_range = RunningRange()
        self.min_ear_sh_dist = math.inf
    def update(self, kpts, l_torso, dt):
        self.context = kpts.get("_context", {})
        ear, sh, hip = (np.asarray(kpts[k]) for k in ("ear", "shoulder", "hip"))
        arm = np.asarray(kpts["elbow"]) - sh
        down = (hip - sh) / np.linalg.norm(hip - sh)
        direction = self.context.get("facing_direction")
        forward = np.array((down[1], -down[0])) * (direction or 1)
        extension = math.degrees(math.atan2(-float(np.dot(arm, forward)), float(np.dot(arm, down))))
        elbow = BiomechanicsMath.angle_2d(sh, kpts["elbow"], kpts["wrist"])
        tilt = BiomechanicsMath.signed_tilt(sh, hip)
        knee_point = np.asarray(kpts["knee"])
        # Long reference segments avoid amplifying a one-pixel error on the short
        # ear-shoulder segment while still checking head, trunk and hip-knee stacking.
        alignment = max(BiomechanicsMath.plumbline_tilt(a, b) for a, b in ((ear, knee_point), (sh, hip), (hip, knee_point)))
        distance = float(np.linalg.norm(ear - sh)) / l_torso
        if not direction:
            self.alerts = ["未能确认侧身朝向，请调整侧视机位或设置朝向"]
            self.abort_rep()
            return {"shoulder_ext": None, "elbow_angle": elbow, "alignment_tilt": alignment, "torso_sway": None}
        if self.state == "IDLE" and extension < 8:
            self.state = "KNEELING_START"
            self.base_ear_sh_dist = distance
        elif self.state == "KNEELING_START" and extension > 12:
            self._begin()
            self.state = "PULLING_BACK"
        if self.active_rep:
            self.max_sh_ext = max(self.max_sh_ext, extension)
            self.min_elbow_ext = min(self.min_elbow_ext, elbow)
            self.max_alignment_tilt = max(self.max_alignment_tilt, alignment)
            self.min_ear_sh_dist = min(self.min_ear_sh_dist, distance)
            self.tilt_range.push(tilt)
            if self.state == "PULLING_BACK" and extension > 20:
                self.state = "PEAK_EXTENSION"
            elif self.state == "PEAK_EXTENSION" and extension < self.max_sh_ext - 5:
                self.state = "RETURNING_FRONT"
        compression = max(0, 1 - self.min_ear_sh_dist / self.base_ear_sh_dist) if self.base_ear_sh_dist and math.isfinite(self.min_ear_sh_dist) else 0
        metrics = {"shoulder_ext": extension, "elbow_angle": elbow, "alignment_tilt": alignment,
                   "max_sh_ext": self.max_sh_ext, "min_elbow_ext": self.min_elbow_ext,
                   "max_alignment_tilt": self.max_alignment_tilt, "torso_sway": self.tilt_range.get_range(),
                   "neck_compression": compression}
        self._observe(metrics, dt)
        self._live_alerts({"max_alignment_tilt": alignment, "min_elbow_ext": elbow, "torso_sway": metrics["torso_sway"], "neck_compression": compression}, include_peak=True)
        if self.active_rep and self.state == "RETURNING_FRONT" and extension < 8:
            self._finish(metrics)
            self.state = "KNEELING_START"
            self.base_ear_sh_dist = distance
        return metrics


class ReformerActionEngine:
    ACTION_CLASSES = {"footwork": FootworkAnalyzer, "feet_in_straps": FeetInStrapsAnalyzer,
                      "pelvic_curl": PelvicCurlAnalyzer, "short_box": ShortBoxFlatBackAnalyzer,
                      "chest_expansion": ChestExpansionAnalyzer}
    def __init__(self, ema_alpha=.65):
        self.ema_alpha = ema_alpha
        self.active_key = "footwork"
        self.reset_session()
    def reset_session(self):
        self.analyzers = {k: cls() for k, cls in self.ACTION_CLASSES.items()}
        self.active_analyzer = self.analyzers[self.active_key]
        self.filtered_kpts = None
        self.last_timestamp = None
        self.l_torso = None
        self.latest_telemetry = None
    def set_action(self, key):
        if key not in self.ACTION_CLASSES:
            return False
        self.active_key = key
        self.reset_session()
        return True
    def _result(self, metrics=None, valid=False, reason="", context=None):
        a = self.active_analyzer
        last = a.last_completed
        status = ("in_progress" if a.active_rep else "insufficient_data")
        if last:
            status = last["assessment_status"]
        result = {"action_key": self.active_key, "action_name": a.name_cn,
                  "prompt_concept": a.prompt_concept, "state": a.state, "rep_count": a.rep_count,
                  "current_score": a.current_score, "diagnosis": a.last_rep_diagnosis,
                  "alerts": list(a.alerts) if valid else [], "metrics": metrics or {},
                  "l_torso": self.l_torso, "observation_valid": valid, "quality_message": reason,
                  "assessment_status": status, "last_completed": copy.deepcopy(last),
                  "measurement_context": context or {}}
        self.latest_telemetry = result
        return result
    def reject_observation(self, reason, timestamp=None):
        self.active_analyzer.abort_rep()
        self.filtered_kpts = None
        self.l_torso = None
        self.last_timestamp = timestamp
        return self._result(reason=reason)
    def process_landmarks(self, lm_dict, frame_w, frame_h, timestamp=None,
                          coordinate_space="auto", visibility=None, measurement_context=None):
        """Process one chronological source frame. Context uses pixels in bed axes.

        context: reference_valid, carriage_valid, carriage_position, carriage_source,
        facing_direction (-1 / +1), view_valid. Never infer carriage from a body joint.
        """
        context = dict(measurement_context or {})
        supplied_time = timestamp is not None
        if timestamp is None:
            timestamp = 0.0 if self.last_timestamp is None else self.last_timestamp + 1 / 30
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool) or not math.isfinite(timestamp):
            return self.reject_observation("源时间戳无效")
        if self.last_timestamp is not None and timestamp <= self.last_timestamp:
            result = copy.deepcopy(self.latest_telemetry or self._result())
            result.update(review_mode=True, quality_message="回看帧未推进分析状态")
            return result
        dt = 1 / 30 if self.last_timestamp is None else timestamp - self.last_timestamp
        if dt > .5:
            self.active_analyzer.abort_rep()
            self.filtered_kpts = None
        self.last_timestamp = timestamp
        a = self.active_analyzer
        try:
            if frame_w <= 0 or frame_h <= 0:
                raise ValueError("画面尺寸无效")
            if not math.isfinite(frame_w) or not math.isfinite(frame_h):
                raise ValueError("画面尺寸无效")
            points = {k: np.asarray(v, dtype=float) for k, v in lm_dict.items() if not k.startswith("_")}
            if not all(k in points for k in a.REQUIRED_POINTS):
                raise ValueError("动作所需关节点不完整")
            if any(v.shape != (2,) or not np.isfinite(v).all() for v in points.values()):
                raise ValueError("关节点坐标无效")
            if visibility is not None and any(not math.isfinite(visibility.get(k, 0)) or visibility.get(k, 0) < .6 for k in a.REQUIRED_POINTS):
                raise ValueError("关键关节被遮挡或置信度不足")
            if context.get("view_valid") is False:
                raise ValueError("需要全身侧视机位；当前视角不能可靠评估")
            if context.get("facing_direction") not in (None, -1, 1):
                raise ValueError("侧身朝向必须为 -1 或 +1")
            if context.get("carriage_position") is not None and not math.isfinite(context["carriage_position"]):
                raise ValueError("滑车测量无效")
            normalized = coordinate_space == "normalized" or (coordinate_space == "auto" and all(np.max(np.abs(v)) <= 2 for v in points.values()))
            if normalized:
                points = {k: v * (frame_w, frame_h) for k, v in points.items()}
            length = float(np.linalg.norm(points["shoulder"] - points["hip"]))
            if length < 20:
                raise ValueError("躯干像素长度过小或骨架退化")
            # Posture gating prevents an arbitrary standing exercise receiving a supine score.
            sh, hip = points["shoulder"], points["hip"]
            if self.active_key in ("footwork", "feet_in_straps", "pelvic_curl") and abs(sh[0] - hip[0]) < .45 * length:
                raise ValueError("当前姿势不符合仰卧动作，请检查动作模式与侧视机位")
            if self.active_key == "short_box":
                thigh = points["knee"] - hip
                if abs(thigh[0]) < .25 * length or abs(thigh[1]) > .65 * length:
                    raise ValueError("短盒平背需要可见的坐姿髋膝位置")
            if self.active_key == "chest_expansion":
                shin = points["ankle"]-points["knee"]
                if (points["knee"][1]-hip[1] < .25*length or abs(shin[0]) < .25*length
                        or abs(shin[1]) > .65*max(np.linalg.norm(shin), 1)):
                    raise ValueError("胸部扩展需要可见的高跪姿与沿床面放置的小腿，不能用站姿代替")
            if self.l_torso is None:
                self.l_torso = length  # Session-fixed scale avoids false speed from scale drift.
            alpha = 1 - (1 - self.ema_alpha) ** (min(dt, .5) * 30)
            if self.filtered_kpts is None:
                self.filtered_kpts = copy.deepcopy(points)
            else:
                self.filtered_kpts = {k: alpha * v + (1 - alpha) * self.filtered_kpts.get(k, v) for k, v in points.items()}
            context["timestamp"] = timestamp
            other_keys = ("other_hip", "other_knee", "other_ankle")
            context["secondary_valid"] = all(k in points for k in other_keys) and (visibility is None or all(math.isfinite(visibility.get(k, 0)) and visibility.get(k, 0) >= .6 for k in other_keys))
            context["carriage_valid"] = bool(context.get("carriage_valid") and context.get("reference_valid") and supplied_time and context.get("carriage_position") is not None)
            if not supplied_time:
                context["timebase_warning"] = "缺少源时间戳，速度不参与判罚"
            kpts = dict(self.filtered_kpts, _context=context)
            metrics = a.update(kpts, self.l_torso, min(dt, .5))
            reason = "" if context.get("reference_valid") else "请标定床架参考点与滑车；当前只显示可观测角度"
            if self.active_key in ("footwork", "feet_in_straps") and not context["secondary_valid"]:
                reason = "另一侧腿部关键点遮挡，双腿动作暂不出具总分"
            return self._result(metrics, True, reason, context)
        except (ValueError, TypeError, KeyError, ZeroDivisionError) as exc:
            return self.reject_observation(str(exc), timestamp)
    @staticmethod
    def unwrap(telemetry):
        return (telemetry or {}).get("live_coaching") or (telemetry or {}).get("reformer") or telemetry or {}
    def export_api_payload(self, latest_telemetry=None, snapshot_path=""):
        outer = latest_telemetry or {}
        ref = self.unwrap(outer) or self.latest_telemetry or {}
        a = self.active_analyzer
        last = a.last_completed
        score = last["score"] if last else None
        status = last["assessment_status"] if last else ("in_progress" if a.active_rep else "insufficient_data")
        return {
            "protocol_version": "2.0-reformer-kpi", "timestamp": time.time(),
            "assessment_scope": "2d_kinematic_screening", "assessment_status": status,
            "exercise_meta": {"action_key": self.active_key, "action_name_cn": a.name_cn,
                              "repetition_index": a.rep_count, "current_repetition_score": score,
                              "is_passing": score >= 75 if score is not None else False},
            "kinematic_metrics": copy.deepcopy(last["metrics"] if last else ref.get("metrics", {})),
            "live_kinematic_metrics": copy.deepcopy(ref.get("metrics", {})),
            "hinge_loss_deductions": copy.deepcopy(last["deductions"] if last else []),
            "missing_measurements": copy.deepcopy(last["missing_measurements"] if last else ["completed_repetition"]),
            "completed_repetition": copy.deepcopy(last),
            "live_interaction": {"state": ref.get("state", a.state), "live_cue": ref.get("live_cue", ref.get("quality_message", "")),
                                 "is_var_slow": bool(outer.get("is_var_slow", False)), "effective_speed": outer.get("effective_speed", 1.0),
                                 "observation_valid": bool(ref.get("observation_valid")), "review_mode": bool(outer.get("review_mode", False))},
            "visual_context": {"keyframe_image_file": snapshot_path, "annotated_layers": ["angle_arcs", "degree_pills", "bed_reference"]},
            "ai_agent_diagnosis": {"status": "not_requested", "score": score, "rating": "待生成反馈", "report_markdown": "", "cues": []},
            "limitations": ["二维关键点不能测量组织负荷、诊断损伤或证实椎骨逐节卷动", "动作模式由使用者选择，不能据此证明器械与绳索配置正确"],
        }
    def generate_multimodal_prompt(self, latest_metrics=None):
        import json
        payload = self.export_api_payload(latest_metrics)
        return ("请依据以下 Reformer 二维动作筛查数据提供训练反馈。只解释有数据支持的观测；"
                "缺失标定、未完成或缺失指标必须明确说明，不得宣称正常、捕获代偿或诊断组织损伤。\n"
                + json.dumps(payload, ensure_ascii=False, indent=2))
