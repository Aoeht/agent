# ai-agent 沙箱脚本执行镜像（run_script 的 docker 后端，见 src/tools/sandbox_docker.ts）
# 在仓库根目录构建一次：
#   docker build -t ai-agent-sandbox:latest tools/sandbox/
# 前提：Docker Desktop → Settings → Resources → File Sharing 需包含沙箱目录所在盘符（如 A:\）
#
# 镜像即解释器白名单：python3 / bun / bash 由这里保证存在，host 后端的 --version 预检
# 在容器模式下不再需要。只跑 python 时删掉 bun 的 COPY 行可以让镜像小一半。
#
# digest 锁定：浮动 tag（3.12-slim / 1）会被上游重新推送悄悄替换，digest 才是身份。
# 升级流程：改 tag → 构建冒烟（docker run --rm 镜像 python3 --version 等）→
# 用下方注释里的 registry 查询命令取新 digest 回填，提交 diff 里 digest 变化即升级记录。
# 查询 digest（PowerShell）：
#   $t=(Invoke-RestMethod "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/python:pull").token
#   (Invoke-WebRequest -Uri "https://registry-1.docker.io/v2/library/python/manifests/3.12-slim" `
#     -Headers @{Authorization="Bearer $t";Accept="application/vnd.oci.image.index.v1+json"} -Method Head).Headers["Docker-Content-Digest"]
#   （oven/bun 同理，把 repository 换成 oven/bun、tag 换成 1）
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

# bun：单文件二进制，直接从官方镜像拷贝（.js/.mjs/.ts 用）
# digest 锁定理由同上；1 与 distroless 变体不同 tag，更新时两处一起改
COPY --from=oven/bun:1@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 /usr/local/bin/bun /usr/local/bin/bun

# 非 root 固定 uid 1000：与 run_script 的 -u 1000:1000 对齐
RUN useradd -m -u 1000 sandbox

# 只读 rootfs 下写不进 $HOME，缓存与临时文件统一指到 tmpfs；字节码缓存一并关掉
ENV PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    XDG_CACHE_HOME=/tmp/cache

USER sandbox
WORKDIR /workspace
