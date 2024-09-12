function showPopup(channelName, videoSrc) {
    document.getElementById('popup').style.display = 'flex';
    document.getElementById('popup-title').innerText = channelName;

    const video = document.getElementById('video-player');

    if (Hls.isSupported()) {
        var hls = new Hls();
        hls.loadSource(videoSrc);
        hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = videoSrc;
    }

    video.play();
}

function closePopup() {
    document.getElementById('popup').style.display = 'none';
    const video = document.getElementById('video-player');
    video.pause();
    video.src = ''; // تفريغ المصدر لإيقاف البث
}