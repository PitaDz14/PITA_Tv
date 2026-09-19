<?php

// ضع هنا رابط صفحة Duhok Sport الأصلية التي تحتوي على encUrl
$sourcePage = 'duhoksport.net';

$context = stream_context_create([
    'http' => [
        'timeout' => 10,
        'user_agent' => 'Mozilla/5.0'
    ]
]);

$html = @file_get_contents($sourcePage, false, $context);

if (!$html) {
    http_response_code(502);
    exit('Unable to load stream.');
}

// استخراج encUrl
if (!preg_match('/var\s+encUrl\s*=\s*["\']([^"\']+)["\']/', $html, $m)) {
    exit('Stream URL not found.');
}

$streamUrl = base64_decode($m[1], true);

if (!$streamUrl) {
    exit('Invalid stream URL.');
}

// السماح فقط بروابط OK.ru embed
$host = parse_url($streamUrl, PHP_URL_HOST);

if (!in_array($host, ['ok.ru', 'www.ok.ru'], true)) {
    exit('Invalid stream host.');
}

?>
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body {
    width:100%;
    height:100%;
    margin:0;
    padding:0;
    overflow:hidden;
    background:#000;
}

iframe {
    position:fixed;
    inset:0;
    width:100%;
    height:100%;
    border:0;
}
</style>
</head>

<body>

<iframe
    src="<?= htmlspecialchars($streamUrl, ENT_QUOTES, 'UTF-8') ?>"
    allow="autoplay; fullscreen; picture-in-picture"
    allowfullscreen>
</iframe>

</body>
</html>
