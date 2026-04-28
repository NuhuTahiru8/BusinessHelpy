<?php
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $message = $_POST['message'];
    $sender = $_POST['sender'];
    $recipientPhone = $_POST['recipientPhone'];

    if (empty($message) || empty($sender) || empty($recipientPhone)) {
        echo json_encode(['status' => 'error', 'message' => 'Please fill in all fields']);
        exit;
    }

    $apiKey = 'dEVtRGVTcXJXVElPVEVDa3R2b3I';
    $apiUrl = "https://sms.arkesel.com/sms/api?action=send-sms&api_key=$apiKey&to=$recipientPhone&from=$sender&sms=" . urlencode($message);

    $curl = curl_init();
    curl_setopt_array($curl, array(
        CURLOPT_URL => $apiUrl,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_ENCODING => '',
        CURLOPT_MAXREDIRS => 10,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_CUSTOMREQUEST => 'GET',
    ));
    $response = curl_exec($curl);
    
    // Check for cURL errors
    if (curl_errno($curl)) {
        echo json_encode(['status' => 'error', 'message' => 'cURL error: ' . curl_error($curl)]);
        curl_close($curl);
        exit;
    }

    curl_close($curl);

    $data = json_decode($response, true);

    // Check if the response contains the expected data
    if ($data === null) {
        echo json_encode(['status' => 'error', 'message' => 'Invalid JSON response']);
        exit;
    }

    if ($data['status'] === 'success') {
        echo json_encode(['status' => 'success']);
    } else {
        // Include the raw response for debugging
        echo json_encode(['status' => 'error', 'message' => $data['message'] ?? 'Unknown error', 'raw_response' => $response]);
    }
} else {
    echo json_encode(['status' => 'error', 'message' => 'Invalid request method']);
}
?>
