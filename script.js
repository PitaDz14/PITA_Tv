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
// تفعيل وضع ملء الشاشة
function toggleFullScreen() {
    const video = document.getElementById('video-player');
    if (video.requestFullscreen) {
        video.requestFullscreen();
    } else if (video.mozRequestFullScreen) { // Firefox
        video.mozRequestFullScreen();
    } else if (video.webkitRequestFullscreen) { // Chrome, Safari and Opera
        video.webkitRequestFullscreen();
    } else if (video.msRequestFullscreen) { // IE/Edge
        video.msRequestFullscreen();
    }
}

// دعم DLNA عبر توجيه المستخدم
function showDlnaInstructions() {
    alert("لإرسال الفيديو إلى تلفاز يدعم DLNA، استخدم متصفح خارجي مثل Web Video Caster وافتح الرابط.");
}
