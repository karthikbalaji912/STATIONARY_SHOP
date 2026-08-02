fetch("https://api.telegram.org")
  .then(res => console.log("Status:", res.status))
  .catch(err => console.error(err));