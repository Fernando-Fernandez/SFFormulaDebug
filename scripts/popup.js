document.addEventListener('DOMContentLoaded', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { message: "getData" }, (response) => {
            if (response) {
                document.getElementById('result').textContent = response.resultData;
                if (response.debugResult) {
                    document.getElementById('debugResult').textContent = response.debugResult;
                }
            } else {
                document.getElementById('result').textContent = 'No response from content script.';
            }
        });
    });
});