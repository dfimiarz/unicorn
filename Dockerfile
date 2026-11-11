# Unicorn Craft in a container: the game's files and the server that serves them.
#
#   docker build -t unicorn-craft .
#   docker run --rm -p 8080:8080 unicorn-craft
#
# then open http://localhost:8080/. Friends on the same network open this computer's address with
# the same port. To play over the internet, put it behind something that gives it an https address;
# if that hides the address players use, add -e ORIGIN=play.example.com (see server/main.go).
#
# The image is built for the kind of computer it's built on. Most hosting runs on Intel/AMD, so
# on a Mac with Apple silicon build the one to send there with
#
#   docker build --platform linux/amd64 -t unicorn-craft .

# Builds the server: it needs nothing outside Go's standard library. Go builds for other kinds of
# computer by itself, so this stage always runs as the computer doing the building (quickly).
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY server ./server
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /unicorn ./server

# The game itself: the server and the files it serves, and nothing else (no shell, no system).
# A new top-level file the game loads goes here as well as in `served` in server/main.go.
FROM scratch
WORKDIR /game
COPY --from=build /unicorn /unicorn
COPY index.html screech.m4a ./
COPY css ./css
COPY js ./js
# the server only sees the container's own addresses, so it doesn't offer them for friends to join at
ENV PORT=8080 IN_CONTAINER=1
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/unicorn"]
