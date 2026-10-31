"""Local RTSP-to-browser adapter. Keeps only the latest frame in memory."""
import base64
import ipaddress
import re
import threading
import time
from urllib.parse import urlsplit
import cv2


class CameraError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate_url(value):
    try:
        url = urlsplit(value)
        host = ipaddress.IPv4Address(url.hostname)
        networks = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
        if (url.scheme != 'rtsp' or not any(host in ipaddress.IPv4Network(n) for n in networks)
                or url.username is not None or url.password is not None or url.fragment
                or url.query or url.port not in (554, 8554) or not url.path.startswith('/')
                or len(value) > 300 or any(ord(c) < 33 for c in value)):
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError):
        raise CameraError('请填写局域网 IPv4 的 RTSP 视频地址，端口为 554 或 8554，不含账号、查询串或文件路径。')


class CameraSource:
    def __init__(self, capture=None, clock=time.monotonic):
        self.capture = capture or (lambda url: cv2.VideoCapture(url, cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 4000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 3000]))
        self.clock = clock
        self.lock = threading.Lock()
        self.operation = threading.Lock()
        self.session = None
        self.closed = {}

    @staticmethod
    def owner(value):
        if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9-]{36}', value):
            raise CameraError('外接摄像头会话无效，请重新连接。')
        return value

    def start(self, owner, url):
        owner, url = self.owner(owner), validate_url(url)
        with self.operation:
            with self.lock:
                self.closed = {k: v for k, v in self.closed.items() if self.clock()-v < 30}
                if owner in self.closed:
                    raise CameraError('这次连接已取消，请重新连接。', 409)
                previous = self.session
                if previous and previous['thread'].is_alive():
                    if previous['owner'] == owner and previous['url'] == url:
                        return {'started': True}
                    raise CameraError('外接摄像头正在被另一个网页使用，请先在该页关闭。', 409)
                stop = threading.Event()
                session = dict(owner=owner, url=url, stop=stop, touched=self.clock(),
                               origin=self.clock(), stamp=0, seq=0, frame=None, error='')
                session['thread'] = threading.Thread(target=self._worker, args=(session,), daemon=True)
                self.session = session
                session['thread'].start()
        return {'started': True}

    def _worker(self, session):
        cap = None
        try:
            cap = self.capture(session['url'])
            if not cap.isOpened():
                raise CameraError('无法打开网络摄像头，请确认设备正在推流且地址正确。')
            published = float('-inf')
            while not session['stop'].is_set():
                if self.clock()-session['touched'] > 8:
                    break
                ok, image = cap.read()
                stamp = self.clock()
                if not ok:
                    raise CameraError('网络摄像头视频已中断，请重新连接。')
                if stamp-published < .1:
                    continue
                height, width = image.shape[:2]
                scale = min(1, 640/max(width, height))
                image = cv2.resize(image, (max(1, round(width*scale)), max(1, round(height*scale))))
                ok, encoded = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 65])
                if not ok or encoded.size > 250000:
                    raise CameraError('摄像头画面编码失败，请降低设备输出分辨率。')
                frame = dict(mime='image/jpeg', width=image.shape[1], height=image.shape[0],
                             data=base64.b64encode(encoded).decode())
                with self.lock:
                    if session['stop'].is_set():
                        break
                    session.update(frame=frame, stamp=stamp, seq=session['seq']+1)
                published = stamp
        except Exception as error:
            with self.lock:
                session['error'] = str(error) if isinstance(error, CameraError) else '网络摄像头读取失败，请检查连接与设备推流。'
        finally:
            if cap is not None:
                cap.release()
            with self.lock:
                session['frame'] = None
                session['stop'].set()

    def frame(self, owner):
        owner = self.owner(owner)
        with self.lock:
            session = self.session
            if not session or session['owner'] != owner:
                raise CameraError('外接摄像头会话已结束，请重新连接。', 409)
            session['touched'] = self.clock()
            if session['error'] or session['stop'].is_set():
                raise CameraError(session['error'] or '摄像头连接已释放，请重新连接。', 503)
            if session['frame'] is None:
                return {'ready': False}
            age = self.clock()-session['stamp']
            if age > .6:
                raise CameraError('摄像头画面已停滞，当前不作为动作取样；请重新连接。', 503)
            return dict(ready=True, sequence=session['seq'],
                        elapsed_seconds=session['stamp']-session['origin'],
                        age_seconds=max(0, age), frame=session['frame'])

    def stop(self, owner):
        owner = self.owner(owner)
        with self.operation:
            with self.lock:
                if len(self.closed) >= 128:
                    self.closed.pop(next(iter(self.closed)))
                self.closed[owner] = self.clock()
                session = self.session
                if not session or session['owner'] != owner:
                    return {'stopped': False}
                session['stop'].set()
            session['thread'].join(timeout=4.5)
            with self.lock:
                if not session['thread'].is_alive() and self.session is session:
                    self.session = None
        return {'stopped': True}


SOURCE = CameraSource()
