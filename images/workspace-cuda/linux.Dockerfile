ARG BASE_IMAGE=ghcr.io/appmana/workspace-base:latest
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04 AS cuda

FROM ${BASE_IMAGE}

USER root

# CUDA runtime libraries from the official runtime image
COPY --from=cuda /usr/local/cuda /usr/local/cuda
ENV PATH=/usr/local/cuda/bin:${PATH} \
    LD_LIBRARY_PATH=/usr/local/cuda/lib64

USER 1000
WORKDIR /workspace

ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
