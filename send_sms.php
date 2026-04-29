<?php
ob_start();

$isHttps = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
if (defined('PHP_VERSION_ID') && PHP_VERSION_ID >= 70300) {
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $isHttps,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
} else {
    session_set_cookie_params(0, '/');
}
session_start();

header('Content-Type: application/json; charset=utf-8');

$users = [
    'admin' => [
        'password' => 'admin1234',
        'brandname' => 'I LOVE U',
    ],
    'staff' => [
        'password' => 'staff1234',
        'brandname' => 'I LOVE U',
    ],
];

function json_error($message, $extra = []) {
    if (ob_get_length() !== false) {
        ob_clean();
    }
    echo json_encode(array_merge(['status' => 'error', 'message' => $message], $extra));
    exit;
}

function json_success($extra = []) {
    if (ob_get_length() !== false) {
        ob_clean();
    }
    echo json_encode(array_merge(['status' => 'success'], $extra));
    exit;
}

function require_login() {
    if (empty($_SESSION['logged_in']) || empty($_SESSION['brandname'])) {
        json_error('Not logged in');
    }
}

$action = $_GET['action'] ?? $_POST['action'] ?? null;

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'session') {
    if (!empty($_SESSION['logged_in']) && !empty($_SESSION['brandname'])) {
        json_success([
            'logged_in' => true,
            'username' => $_SESSION['username'] ?? null,
            'brandname' => $_SESSION['brandname'],
        ]);
    }
    json_success(['logged_in' => false]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'logout') {
    $_SESSION = [];
    if (session_id() !== '') {
        session_destroy();
    }
    json_success();
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'login') {
    $username = trim((string)($_POST['username'] ?? ''));
    $password = (string)($_POST['password'] ?? '');

    if ($username === '' || $password === '') {
        json_error('Username and password are required');
    }

    if (!isset($users[$username]) || !hash_equals($users[$username]['password'], $password)) {
        json_error('Invalid login');
    }

    $_SESSION['logged_in'] = true;
    $_SESSION['username'] = $username;
    $_SESSION['brandname'] = $users[$username]['brandname'];

    json_success([
        'logged_in' => true,
        'username' => $username,
        'brandname' => $_SESSION['brandname'],
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Invalid request method');
}

require_login();

$message = trim((string)($_POST['message'] ?? ''));
$recipientPhone = trim((string)($_POST['recipientPhone'] ?? ''));
$sender = $_SESSION['brandname'];

if ($message === '' || $recipientPhone === '') {
    json_error('Please fill in all fields');
}

if (!preg_match('/^\+?[0-9]{8,15}$/', $recipientPhone)) {
    json_error('Invalid phone number format');
}

$apiKey = getenv('ARKESEL_API_KEY');
if (!$apiKey) {
    json_error('Missing ARKESEL_API_KEY on the server');
}

$apiUrl = "https://sms.arkesel.com/sms/api?action=send-sms"
    . "&api_key=" . urlencode($apiKey)
    . "&to=" . urlencode($recipientPhone)
    . "&from=" . urlencode($sender)
    . "&sms=" . urlencode($message);

$curl = curl_init();
curl_setopt_array($curl, [
    CURLOPT_URL => $apiUrl,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_ENCODING => '',
    CURLOPT_MAXREDIRS => 10,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
    CURLOPT_CUSTOMREQUEST => 'GET',
]);

$response = curl_exec($curl);
if (curl_errno($curl)) {
    $err = curl_error($curl);
    curl_close($curl);
    json_error('cURL error', ['detail' => $err]);
}
curl_close($curl);

$data = json_decode($response, true);
if ($data === null) {
    json_error('Invalid JSON response', ['raw_response' => $response]);
}

if (($data['status'] ?? null) === 'success') {
    json_success();
}

json_error($data['message'] ?? 'Unknown error', ['raw_response' => $response]);
?>
