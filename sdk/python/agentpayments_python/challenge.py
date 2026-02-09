import json


def challenge_html(return_to: str, nonce: str) -> str:
    safe_path = return_to if return_to.startswith("/") else "/"
    nonce_json = json.dumps(nonce)
    safe_path_json = json.dumps(safe_path)
    return f"""<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>Just a moment...</title></head><body><script>(function(){{if(navigator.webdriver)return;var c=document.createElement('canvas');c.width=200;c.height=50;var ctx=c.getContext('2d');if(!ctx)return;ctx.font='18px Arial';ctx.fillStyle='#1a1a2e';ctx.fillText('verify',10,30);var data=c.toDataURL();if(!data||data.length<100)return;if(typeof window.innerWidth==='undefined'||window.innerWidth===0)return;var form=document.createElement('form');form.method='POST';form.action='/__challenge/verify';var fields={{nonce:{nonce_json},return_to:{safe_path_json},fp:data.slice(22,86)}};for(var k in fields){{var input=document.createElement('input');input.type='hidden';input.name=k;input.value=fields[k];form.appendChild(input);}}document.body.appendChild(form);form.submit();}})();</script></body></html>"""
