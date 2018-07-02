# ------------------------------
# The build image
# ------------------------------
FROM alpine:3.7 as builder

# add deps for building kbase-ui
RUN apk upgrade --update-cache --available \
    && apk add --update --no-cache \
        nodejs=8.9.3-r1 \
        nodejs-npm=8.9.3-r1 \
        git=2.15.2-r0 \
        make=4.2.1-r0 \
        bash=4.4.19-r1 \
        python=2.7.14-r2 \
        g++=6.4.0-r5 \
        chromium=61.0.3163.100-r0 \
    && mkdir -p /kb

COPY ./package.json /kb
WORKDIR /kb
RUN npm install

COPY . /kb

ARG BUILD

# This actually builds the ui codebase. Note that the build-arg BUILD is passed along
# as an environment variabl 'build'.
RUN make setup && make build config=$BUILD && make docs

# Run unit tests.
RUN make unit-tests

LABEL stage=intermediate

# ------------------------------
# The product image
# ------------------------------
FROM alpine:3.7

RUN apk upgrade --update-cache --available \
    && apk add --update --no-cache \
        bash=4.4.19-r1 \
        nginx=1.12.2-r3 \
    && mkdir -p /kb

WORKDIR /kb

# this pulls down the kbase custom dockerize, which includes url fetching.
# note: fixed to this commit because this dockerfile ensures reproducible builds.
# TODO: better would be if the 
# RUN archive=dockerize-alpine-linux-amd64-v0.6.1.tar.gz \
#     commit=1c2a8d81f8b0793fab2d1dd80420f0c382a5fe1f \
#     && wget https://raw.github.com/kbase/dockerize/$commit/$archive \
#     && tar -C /usr/local/bin -xzvf $archive \
#     && rm $archive

# This version uses master; otherwise functionally equivalent other than style.
RUN archive=dockerize-alpine-linux-amd64-v0.6.1.tar.gz && \
	wget https://github.com/kbase/dockerize/raw/master/$archive && \
	tar xvzf $archive && \
    rm $archive && \
	mv dockerize /usr/local/bin

# These ARGs values are passed in via the docker build command
ARG BUILD_DATE
ARG VCS_REF
ARG BRANCH=develop
ARG TAG

RUN mkdir -p /kb/deployment/services/kbase-ui

# The main thing -- the kbase-ui built code.
COPY --from=builder /kb/build/dist/client /kb/deployment/services/kbase-ui/dist/

# Config templates
COPY --from=builder /kb/deployment/templates /kb/deployment/templates

# Config files for each deployment environment. 
# TODO: hopefully kbase/dockerize will be updated to pull configs from 
#       the deploy environment not the image itself.
COPY --from=builder /kb/deployment/config /kb/deployment/config

# Deployment-time scripts
COPY --from=builder /kb/deployment/scripts /kb/deployment/scripts

# Generated documentation is copied into the distribution.
COPY --from=builder /kb/docs/book/_book /kb/deployment/services/kbase-ui/dist/_book

# The BUILD_DATE value seem to bust the docker cache when the timestamp changes, move to
# the end
LABEL org.label-schema.build-date=$BUILD_DATE \
      org.label-schema.vcs-url="https://github.com/kbase/kbase-ui.git" \
      org.label-schema.vcs-ref=$VCS_REF \
      org.label-schema.schema-version="1.0.0-rc1" \
      us.kbase.vcs-branch=$BRANCH  \
      us.kbase.vcs-tag=$TAG \ 
      maintainer="Steve Chan sychan@lbl.gov"

ENTRYPOINT [ "dockerize", \
             "-template", "/kb/deployment/templates/nginx.conf.tmpl:/etc/nginx/nginx.conf", \
             "-template", "/kb/deployment/templates/config.json.tmpl:/kb/deployment/services/kbase-ui/dist/modules/deploy/config.json" ]

CMD [  "bash", "/kb/deployment/scripts/start-server.bash" ]
      