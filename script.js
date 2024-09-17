// عرض الفئة المحددة من القنوات
function showCategory(category) {
    document.querySelectorAll('.category').forEach(el => el.style.display = 'none');
    document.getElementById(category).style.display = 'block';
}

// عرض النافذة المنبثقة للفيديو
function showPopup(channelName, videoSrc) {
    document.getElementById('popup').style.display = 'flex';
    document.getElementById('popup-title').innerText = channelName;
    
    const video = document.getElementById('video-player');
    video.src = videoSrc;
    video.play();
}

// إغلاق النافذة المنبثقة
function closePopup() {
    document.getElementById('popup').style.display = 'none';
    const video = document.getElementById('video-player');
    video.pause();
    video.src = '';
}

// تفعيل وضع ملء الشاشة للفيديو
function toggleFullScreen() {
    const video = document.getElementById('video-player');
    if (video.requestFullscreen) {
        video.requestFullscreen();
    } else if (video.mozRequestFullScreen) {
        video.mozRequestFullScreen();
    } else if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
    } else if (video.msRequestFullscreen) {
        video.msRequestFullscreen();
    }
}

// نظام التعليقات
let comments = [];

function submitComment() {
    const comment = document.getElementById('user-comment').value;
    if (comment) {
        comments.push(comment);
        displayComments();
        document.getElementById('user-comment').value = '';
    }
}

function displayComments() {
    const commentsList = document.getElementById('comments-list');
    commentsList.innerHTML = comments.map(c => `<p>${c}</p>`).join('');
}