"""Explicit three-point Reformer reference, tracked without inferring bed motion from joints."""
import math
import cv2
import numpy as np


class ReformerReferenceTracker:
    def __init__(self):
        self.clear()

    def clear(self):
        self.valid = False
        self.message = "未标定床架与滑车"
        self.gray = None
        self.features = None
        self.groups = None
        self.anchors = None

    def calibrate(self, frame, points):
        self.clear()
        anchors = np.asarray(points, dtype=np.float32)
        if anchors.shape != (3, 2) or not np.isfinite(anchors).all():
            raise ValueError("需要床架固定点 A、B 和滑车点 C，共三个点")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        if any(not (0 <= x < w and 0 <= y < h) for x, y in anchors):
            raise ValueError("标定点必须在画面内")
        axis = anchors[1] - anchors[0]
        if axis[0] < 30 or abs(axis[1]) > abs(axis[0]) * .7:
            raise ValueError("请沿床面从左向右选择相距至少 30 像素的两个固定点")
        self.initial_length = float(np.linalg.norm(axis))
        features, groups = [], []
        for index, (x, y) in enumerate(anchors):
            mask = np.zeros_like(gray)
            x, y = int(x), int(y)
            mask[max(0, y-18):min(h, y+19), max(0, x-18):min(w, x+19)] = 255
            corners = cv2.goodFeaturesToTrack(gray, 12, .03, 3, mask=mask)
            if corners is None or len(corners) < 3:
                raise ValueError(f"标定点 {'ABC'[index]} 附近纹理不足，请选择清晰的边角或标记")
            features.extend(corners.reshape(-1, 2))
            groups.extend([index] * len(corners))
        self.anchors = anchors
        self.features = np.asarray(features, dtype=np.float32).reshape(-1, 1, 2)
        self.groups = np.asarray(groups)
        self.gray = gray
        self.valid = True
        self.message = "床架与滑车跟踪有效"

    def update(self, frame):
        if not self.valid:
            return {"reference_valid": False, "carriage_valid": False, "tracking_message": self.message}
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if gray.shape != self.gray.shape:
            return self._lost("画面尺寸改变，请重新标定")
        nxt, status, error = cv2.calcOpticalFlowPyrLK(self.gray, gray, self.features, None, winSize=(25, 25), maxLevel=3)
        if nxt is None:
            return self._lost("床体跟踪丢失，请重新标定")
        back, reverse_status, _ = cv2.calcOpticalFlowPyrLK(gray, self.gray, nxt, None, winSize=(25, 25), maxLevel=3)
        if back is None:
            return self._lost("床体反向跟踪验证失败，请重新标定")
        good = (status.ravel() == 1) & (reverse_status.ravel() == 1)
        good &= np.linalg.norm(back.reshape(-1, 2) - self.features.reshape(-1, 2), axis=1) < 1.5
        good &= error.ravel() < 35
        updated = self.anchors.copy()
        for index in range(3):
            chosen = good & (self.groups == index)
            if np.count_nonzero(chosen) < 3:
                return self._lost(f"标定点 {'ABC'[index]} 遮挡或跟踪丢失，请重新标定")
            displacement = nxt.reshape(-1, 2)[chosen] - self.features.reshape(-1, 2)[chosen]
            updated[index] += np.median(displacement, axis=0)
        axis = updated[1] - updated[0]
        length = float(np.linalg.norm(axis))
        old_length = float(np.linalg.norm(self.anchors[1] - self.anchors[0]))
        if length < 30 or abs(length / old_length - 1) > .15 or axis[0] <= 0:
            return self._lost("床架参考点变化过大，请检查机位与标定")
        self.anchors, self.gray = updated, gray
        self.features, self.groups = nxt[good], self.groups[good]
        return self.context()

    def _lost(self, message):
        self.valid = False
        self.message = message
        return {"reference_valid": False, "carriage_valid": False, "tracking_message": message}

    def transform(self, point):
        axis = self.anchors[1] - self.anchors[0]
        length = float(np.linalg.norm(axis))
        horizontal = axis / length
        down = np.array((-horizontal[1], horizontal[0]))
        offset = np.asarray(point) - self.anchors[0]
        scale = self.initial_length / length
        return (float(np.dot(offset, horizontal) * scale), float(np.dot(offset, down) * scale))

    def context(self):
        return {"reference_valid": True, "carriage_valid": True,
                "carriage_position": self.transform(self.anchors[2])[0],
                "carriage_source": "tracked_carriage_marker", "tracking_message": self.message}

    def draw(self, frame):
        if self.anchors is None:
            return
        color = (60, 210, 80) if self.valid else (30, 30, 230)
        for label, point in zip("ABC", self.anchors):
            x, y = map(int, point)
            cv2.circle(frame, (x, y), 6, color, 2)
            cv2.putText(frame, label, (x + 8, y - 8), cv2.FONT_HERSHEY_SIMPLEX, .6, color, 2)
