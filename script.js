// Attach event listener for senderName input
var senderNameInput = document.getElementById('senderName');
if (senderNameInput) {
    senderNameInput.addEventListener('input', function() {
        var senderName = this.value;
        var senderElements = document.querySelectorAll('.sender');
        senderElements.forEach(function(element) {
            element.textContent = senderName || 'Sender';
        });
    });
}

// Attach event listener for Message1 input
var messageInput = document.getElementById('Message1');
if (messageInput) {
    messageInput.addEventListener('input', function() {
        var messageText = this.value;
        var messageElements = document.querySelectorAll('.message p');
        messageElements.forEach(function(element) {
            if (element.textContent.includes("Eg:You are the girl I will die for. If I were to rate you on a scale of 1 to 10, you would be an 11. - From Nuhu Tahiru")) {
                element.textContent = messageText || "Eg:You are the girl I will die for. If I were to rate you on a scale of 1 to 10, you would be an 11. - From Nuhu Tahiru";
            }
        });
    });
}

// Retrieve templateText from local storage
var templateText = localStorage.getItem('templateText');
if (templateText) {
    // Set Message1 value
    var messageInput = document.getElementById('Message1');
    if (messageInput) {
        messageInput.value = templateText;
        // Trigger input event
        var event = new Event('input', {
            bubbles: true,
            cancelable: true,
        });
        messageInput.dispatchEvent(event);
    }

    // Clear local storage
    localStorage.removeItem('templateText');
}

// Function to handle using a template
function useTemplate(templateText) {
    // Store the template text in local storage
    localStorage.setItem('templateText', templateText);
    // Redirect to the home page
    window.location.href = 'index.html';
}

document.getElementById('Message1').addEventListener('input', function() {
    var messageText = this.value;
    var messageElements = document.querySelectorAll('.message p');
    messageElements.forEach(function(element) {
        element.textContent = messageText || "Eg:You are the girl I will die for. If I were to rate you on a scale of 1 to 10, you would be an 11. - From Nuhu Tahiru";
    });
});

// Function to send SMS
function sendSMS() {
    var message = document.getElementById('Message1').value;
    var sender = document.getElementById('senderName').value;
    var recipientPhone = document.getElementById('recipientPhone').value;

    if (!message || !sender || !recipientPhone) {
        alert("Please fill in all fields");
        return;
    }

    var data = new FormData();
    data.append('message', message);
    data.append('sender', sender);
    data.append('recipientPhone', recipientPhone);

    fetch('send_sms.php', {
        method: 'POST',
        body: data
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            alert('SMS sent successfully!');
        } else {
            alert('Failed to send SMS: ' + data.message + (data.raw_response ? '\nRaw Response: ' + data.raw_response : ''));
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('An error occurred while sending the SMS.');
    });
}


