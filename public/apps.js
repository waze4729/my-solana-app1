const scanBtn = document.getElementById("scanBtn");
const output = document.getElementById("output");

scanBtn.addEventListener("click", async () => {
  const tokenMint = document.getElementById("tokenMint").value.trim();
  if (!tokenMint) return alert("Please enter a token mint");

  output.textContent = "Scanning...";

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenMint }),
    });
    const data = await res.json();
    output.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    output.textContent = "Error scanning token";
    console.error(err);
  }
});
