FROM node:22-bookworm-slim AS node
FROM python:3.11-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MPLCONFIGDIR=/tmp/qingxu-matplotlib
WORKDIR /opt/qingxu
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY app/vision/requirements.txt /tmp/vision-requirements.txt
RUN pip install --no-cache-dir -r /tmp/vision-requirements.txt && python -c "import cv2, mediapipe as mp, numpy; assert hasattr(mp, 'solutions'); p=mp.solutions.pose.Pose(model_complexity=1); p.close()"
COPY app ./app
COPY hosting ./hosting
RUN useradd --create-home --uid 10001 qingxu && chown -R qingxu:qingxu /opt/qingxu
USER qingxu
EXPOSE 10000
CMD ["node", "hosting/start.cjs"]
