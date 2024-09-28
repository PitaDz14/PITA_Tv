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
let mediaDisplay = document.querySelector('#media-display');

// تكبير الإطار الذي يحتوي على الوسائط
mediaDisplay.style.width = '90%';
mediaDisplay.style.height = '80vh';  // تحديد ارتفاع مناسب للشاشة
mediaDisplay.style.margin = '0 auto';  // توسيط الإطار في الصفحة
mediaDisplay.style.display = 'flex';
mediaDisplay.style.justifyContent = 'center';
mediaDisplay.style.alignItems = 'center';

// التأكد من تكبير الفيديو أو المحتوى داخل الإطار أيضًا
let video = document.createElement('video');
video.style.width = '100%';  // عرض الفيديو بنفس عرض الإطار
video.style.height = '100%'; // ضبط الارتفاع تلقائيًا ليشغل كامل الإطار
mediaDisplay.appendChild(video);
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
