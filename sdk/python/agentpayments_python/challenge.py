import json


def challenge_html(return_to: str, nonce: str) -> str:
    safe_path = return_to if return_to.startswith("/") else "/"
    nonce_json = json.dumps(nonce)
    safe_path_json = json.dumps(safe_path)
    return (
        "<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1.0'>"
        "<title>Verifying your access...</title>"
        "<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;"
        "align-items:center;min-height:100vh;margin:0;background:#fafafa;color:#333}"
        "main{text-align:center;padding:2rem}"
        ".spinner{width:40px;height:40px;border:4px solid #e0e0e0;border-top-color:#333;"
        "border-radius:50%;animation:spin .8s linear infinite;margin:1rem auto}"
        "@keyframes spin{to{transform:rotate(360deg)}}</style>"
        "</head><body>"
        "<main role='status' aria-live='polite'>"
        "<div class='spinner' aria-hidden='true'></div>"
        "<p>Verifying your access&hellip;</p>"
        "<noscript><p><strong>JavaScript is required to verify your access. "
        "Please enable JavaScript and reload this page.</strong></p></noscript>"
        "</main>"
        "<script>(function(){"
        "if(navigator.webdriver)return;"
        "var c=document.createElement('canvas');c.width=200;c.height=50;"
        "var ctx=c.getContext('2d');if(!ctx)return;"
        "ctx.font='18px Arial';ctx.fillStyle='#1a1a2e';ctx.fillText('verify',10,30);"
        "var data=c.toDataURL();if(!data||data.length<100)return;"
        "if(typeof window.innerWidth==='undefined'||window.innerWidth===0)return;"
        "var form=document.createElement('form');form.method='POST';form.action='/__challenge/verify';"
        f"var fields={{nonce:{nonce_json},return_to:{safe_path_json},fp:data.slice(22,86)}};"
        "for(var k in fields){var input=document.createElement('input');"
        "input.type='hidden';input.name=k;input.value=fields[k];form.appendChild(input);}"
        "document.body.appendChild(form);form.submit();})();</script>"
        "</body></html>"
    )
