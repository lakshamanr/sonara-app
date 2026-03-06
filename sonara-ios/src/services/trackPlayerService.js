/**
 * TrackPlayer service handler — must be registered as background task.
 * Required by react-native-track-player.
 */
const TrackPlayer = require('react-native-track-player').default;
const { Event } = require('react-native-track-player');

async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => TrackPlayer.seekTo(position));
  TrackPlayer.addEventListener(Event.RemoteDuck, async ({ permanent, paused }) => {
    if (permanent) {
      TrackPlayer.stop();
    } else if (paused) {
      TrackPlayer.pause();
    } else {
      TrackPlayer.play();
    }
  });
}

module.exports = { PlaybackService };
