#!/usr/bin/env python3
"""
Script to test the streaming SSE endpoint at /copilot
"""

import requests
import json
import time
import sys
from typing import Dict, Any, Optional

class StreamingTester:
    def __init__(self, base_url: str, auth_token: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        
        # Set up authentication if provided
        if auth_token:
            self.session.headers.update({
                'Authorization': f'Bearer {auth_token}'
            })
    
    def test_streaming_endpoint(self, 
                              query: str = "Hello, how are you?",
                              model: str = "RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16",
                              user_id: str = "clark.cucinell",
                              session_id: str = 'test-session-steam',
                              save_chat: bool = False,
                              system_prompt: Optional[str] = None,
                              include_history: bool = False,
                              rag_db: Optional[str] = None,
                              num_docs: Optional[int] = None,
                              image: Optional[str] = None,
                              enhanced_prompt: Optional[str] = None) -> None:
        """
        Test the streaming copilot endpoint
        """
        
        # Prepare request payload
        payload = {
            "query": query,
            "model": model,
            "user_id": user_id,
            "stream": True,
            "save_chat": False,  # Don't save test chats
            "include_history": True
        }
        
        if session_id:
            payload["session_id"] = session_id
        
        if system_prompt:
            payload["system_prompt"] = system_prompt
        
        print(f"🚀 Testing streaming endpoint: {self.base_url}/copilot")
        print(f"📝 Query: {query}")
        print(f"🤖 Model: {model}")
        print("-" * 50)
        
        try:
            # Make streaming request
            response = self.session.post(
                f"{self.base_url}/copilot",
                json=payload,
                headers={
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache'
                },
                stream=True,
                timeout=30
            )
            
            # Check if request was successful
            if response.status_code != 200:
                print(f"❌ Error: HTTP {response.status_code}")
                print(f"Response: {response.text}")
                return
            
            print("✅ Connected to stream")
            print("📡 Receiving events...\n")
            
            # Parse SSE stream
            self._parse_sse_stream(response)
            
        except requests.exceptions.Timeout:
            print("⏰ Request timed out")
        except requests.exceptions.ConnectionError:
            print("🔌 Connection error - check if server is running")
        except KeyboardInterrupt:
            print("\n🛑 Stream interrupted by user")
        except Exception as e:
            print(f"❌ Unexpected error: {e}")
    
    def _parse_sse_stream(self, response):
        """
        Parse Server-Sent Events stream
        """
        buffer = ""
        
        try:
            for chunk in response.iter_content(chunk_size=1, decode_unicode=True):
                if chunk:
                    buffer += chunk
                    
                    # Process complete lines
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        self._process_sse_line(line.rstrip('\r'))
                        
        except Exception as e:
            print(f"❌ Error parsing stream: {e}")
    
    def _process_sse_line(self, line: str):
        """
        Process individual SSE line
        """
        if not line.strip():
            return

        if line.startswith('event:'):
            event_type = line[6:].strip()
            print(f"🎯 Event: {event_type}")

        elif line.startswith('data:'):
            # Remove the single space that typically follows the colon, but
            # PRESERVE any leading spaces that are part of the streamed text
            raw = line[5:]
            if raw.startswith(' '):
                raw = raw[1:]
            data = raw

            # Stream terminator
            if data == '[DONE]':
                print("\n✅ Stream complete\n")
                return

            # The backend sends plain text chunks with newlines escaped as \n
            text = data.replace('\\n', '\n')
            # Try to pretty print JSON if the chunk looks like JSON, otherwise treat as raw text
            try:
                parsed = json.loads(text)
                self._handle_json_data(parsed)
            except json.JSONDecodeError:
                # Plain text – print directly
                print(text, end='', flush=True)

        elif line.startswith(':'):
            # Comment line, ignore
            pass
        else:
            print(f"🔍 Raw: {line}")
    
    def _handle_json_data(self, data: Dict[str, Any]):
        """
        Handle parsed JSON data from the stream
        """
        if 'content' in data:
            # Stream content chunk
            content = data['content']
            print(f"💬 {content}", end='', flush=True)
            
        elif 'message' in data:
            # Status or error message
            message = data['message']
            print(f"\n📢 Message: {message}")
            
        elif 'error' in data:
            # Error occurred
            print(f"\n❌ Error: {data['error']}")
            
        else:
            # Other data
            print(f"\n📊 Data: {json.dumps(data, indent=2)}")

def main():
    """
    Main function to run the streaming test
    """

    import argparse

    parser = argparse.ArgumentParser(description="Interactive SSE streaming tester for BV-BRC Copilot")
    parser.add_argument("--base-url", required=False, default="https://dev-3.bv-brc.org/copilot-api/chatbrc", help="Base URL of the Copilot API")
    parser.add_argument("--auth-token", required=False, default=None, help="Bearer token for authentication")
    parser.add_argument("--model", required=False, default="RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16", help="Model name to use")
    parser.add_argument("--user-id", required=False, default="clark.cucinell", help="User ID to send with the request")
    args = parser.parse_args()

    tester = StreamingTester(args.base_url, args.auth_token)

    print("🧪 BV-BRC Copilot Streaming Test – interactive mode")
    print("Type a prompt and press Enter. Type 'exit' or Ctrl-C to quit.")

    session_id = f"test-session-{int(time.time())}"

    try:
        while True:
            try:
                user_query = input("\n👤 You: ")
            except EOFError:
                break
            if user_query.strip().lower() in {"exit", "quit", "q"}:
                break

            # Blank line – skip
            if not user_query.strip():
                continue

            print("\n--- STREAM START ---")
            tester.test_streaming_endpoint(
                query=user_query,
                model=args.model,
                user_id=args.user_id,
                session_id=session_id,
                include_history=True
            )
            print("\n--- STREAM END ---")

    except KeyboardInterrupt:
        pass

    print("👋 Bye!")

if __name__ == "__main__":
    main() 