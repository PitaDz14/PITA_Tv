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
let video = document.createElement('video');

// ضبط العرض والارتفاع لتتناسب مع حجم الشاشة، ولكن مع إبقاء الفيديو متجاوبًا
video.style.width = '90%';
video.style.height = 'auto';
video.style.maxHeight = '80vh';  // ضمان ألا يتجاوز ارتفاع الفيديو ارتفاع الشاشة
video.style.display = 'block';
video.style.margin = '0 auto';  // توسيط الفيديو في الصفحة

document.querySelector('#media-display').appendChild(video);

let playBtn = document.querySelector('#play');
let pauseBtn = document.querySelector('#pause');
let stopBtn = document.querySelector('#stop');
let progress = document.querySelector('#progress');
let volume = document.querySelector('#volume');
let fileInput = document.querySelector('#file-input');

// تشغيل الفيديو من ملف خارجي يختاره المستخدم
fileInput.addEventListener('change', (event) => {
    let file = event.target.files[0];
    let url = URL.createObjectURL(file);  // تحويل الملف إلى URL مؤقت
    video.src = url;
    video.play();
});

// تشغيل الوسائط
playBtn.addEventListener('click', () => {
    video.play();
});

// إيقاف مؤقت
pauseBtn.addEventListener('click', () => {
    video.pause();
});

// إيقاف الفيديو
stopBtn.addEventListener('click', () => {
    video.pause();
    video.currentTime = 0;
});

// التحكم في مستوى الصوت
volume.addEventListener('input', (e) => {
    video.volume = e.target.value;
});

// تحديث شريط التقدم
video.addEventListener('timeupdate', () => {
    let value = (video.currentTime / video.duration) * 100;
    progress.value = value;
});

// التحكم في شريط التقدم
progress.addEventListener('input', (e) => {
    let value = e.target.value;
    video.currentTime = (value / 100) * video.duration;
});
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
