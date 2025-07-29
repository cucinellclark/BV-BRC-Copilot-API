import os
import logging
from typing import Dict, Any, Optional
from pathlib import Path
import pyarrow as pa
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
import faiss

from mongo_helper import get_active_rag_configs
from tfidf_vectorizer.tfidf_vectorizer import load_vectorizer_by_path, load_dataset_by_path
from distllm.rag.search import FaissIndexV2

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class VectorDatabasePreloader:
    """Preloads vector databases on startup for faster access."""
    
    def __init__(self):
        self.tfidf_vectorizers = {}  # Cache for TF-IDF vectorizers
        self.tfidf_embeddings = {}   # Cache for TF-IDF embeddings
        self.distllm_retrievers = {} # Cache for distllm retrievers
        self.loaded_configs = {}     # Track loaded configurations
        
    def preload_all_active_databases(self) -> Dict[str, Any]:
        """
        Preload all active vector databases from MongoDB.
        
        Returns:
            Dict containing preload status for each database
        """
        try:
            logger.info("Starting vector database preloading...")
            
            # Get all active RAG configurations from MongoDB
            active_configs = get_active_rag_configs()
            logger.info(f"Found {len(active_configs)} active RAG configurations")
            
            preload_results = {}
            
            for config in active_configs:
                try:
                    result = self._preload_single_config(config)
                    preload_results[config['name']] = result
                except Exception as e:
                    logger.error(f"Failed to preload {config['name']}: {e}")
                    preload_results[config['name']] = {
                        'status': 'error',
                        'error': str(e)
                    }
            
            logger.info(f"Preloading completed. Results: {preload_results}")
            return preload_results
            
        except Exception as e:
            logger.error(f"Error during preloading: {e}")
            return {'error': str(e)}
    
    def _preload_single_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Preload a single RAG configuration.
        
        Args:
            config: RAG configuration from MongoDB
            
        Returns:
            Dict containing preload status
        """
        name = config['name']
        program = config.get('program')
        data = config.get('data', {})
        
        logger.info(f"Preloading {name} (program: {program})")
        
        if program == 'tfidf':
            return self._preload_tfidf_config(name, data)
        elif program == 'distllm':
            return self._preload_distllm_config(name, data)
        else:
            return {
                'status': 'skipped',
                'reason': f'Unknown program: {program}'
            }
    
    def _preload_tfidf_config(self, name: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Preload TF-IDF vectorizer and embeddings.
        
        Args:
            name: Database name
            data: Configuration data containing paths
            
        Returns:
            Dict containing preload status
        """
        try:
            embeddings_path = data.get('embeddings_path')
            vectorizer_path = data.get('vectorizer_path')
            
            if not embeddings_path or not vectorizer_path:
                return {
                    'status': 'error',
                    'error': 'Missing embeddings_path or vectorizer_path'
                }
            
            # Resolve relative paths
            base_path = os.path.dirname(os.path.realpath(__file__))
            embeddings_path = os.path.join(base_path, embeddings_path)
            vectorizer_path = os.path.join(base_path, vectorizer_path)
            
            logger.info(f"Loading TF-IDF vectorizer from {vectorizer_path}")
            vectorizer_table = load_vectorizer_by_path(self.tfidf_vectorizers, vectorizer_path)
            
            if vectorizer_table is None:
                return {
                    'status': 'error',
                    'error': f'Failed to load vectorizer from {vectorizer_path}'
                }
            
            logger.info(f"Loading TF-IDF embeddings from {embeddings_path}")
            embeddings_table = load_dataset_by_path(embeddings_path)
            
            if embeddings_table is None:
                return {
                    'status': 'error',
                    'error': f'Failed to load embeddings from {embeddings_path}'
                }
            
            # Store in cache
            self.tfidf_vectorizers[vectorizer_path] = vectorizer_table
            self.tfidf_embeddings[embeddings_path] = embeddings_table
            self.loaded_configs[name] = {
                'program': 'tfidf',
                'vectorizer_path': vectorizer_path,
                'embeddings_path': embeddings_path
            }
            
            logger.info(f"Successfully preloaded TF-IDF database: {name}")
            return {
                'status': 'success',
                'vectorizer_rows': vectorizer_table.num_rows,
                'embeddings_rows': embeddings_table.num_rows
            }
            
        except Exception as e:
            logger.error(f"Error preloading TF-IDF config {name}: {e}")
            return {
                'status': 'error',
                'error': str(e)
            }
    
    def _preload_distllm_config(self, name: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Preload distllm FAISS index and dataset.
        
        Args:
            name: Database name
            data: Configuration data containing paths
            
        Returns:
            Dict containing preload status
        """
        try:
            dataset_dir = data.get('dataset_dir')
            faiss_index_path = data.get('faiss_index_path')
            
            if not dataset_dir or not faiss_index_path:
                return {
                    'status': 'error',
                    'error': 'Missing dataset_dir or faiss_index_path'
                }
            
            # Resolve relative paths
            base_path = os.path.dirname(os.path.realpath(__file__))
            dataset_dir = os.path.join(base_path, dataset_dir)
            faiss_index_path = os.path.join(base_path, faiss_index_path)
            
            logger.info(f"Loading distllm retriever for {name}")
            logger.info(f"Dataset dir: {dataset_dir}")
            logger.info(f"FAISS index path: {faiss_index_path}")
            
            # Create FAISS index instance
            retriever = FaissIndexV2(
                dataset_dir=Path(dataset_dir),
                faiss_index_path=Path(faiss_index_path),
                precision='float32',
                search_algorithm='exact',
                rescore_multiplier=2,
                num_quantization_workers=1
            )
            
            # Store in cache
            self.distllm_retrievers[name] = retriever
            self.loaded_configs[name] = {
                'program': 'distllm',
                'dataset_dir': dataset_dir,
                'faiss_index_path': faiss_index_path
            }
            
            logger.info(f"Successfully preloaded distllm database: {name}")
            return {
                'status': 'success',
                'dataset_size': len(retriever.dataset),
                'faiss_index_size': retriever.faiss_index.ntotal
            }
            
        except Exception as e:
            logger.error(f"Error preloading distllm config {name}: {e}")
            return {
                'status': 'error',
                'error': str(e)
            }
    
    def get_preloaded_tfidf_data(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get preloaded TF-IDF data for a database.
        
        Args:
            name: Database name
            
        Returns:
            Dict containing vectorizer and embeddings tables, or None if not found
        """
        if name not in self.loaded_configs:
            return None
            
        config = self.loaded_configs[name]
        if config['program'] != 'tfidf':
            return None
            
        vectorizer_path = config['vectorizer_path']
        embeddings_path = config['embeddings_path']
        
        vectorizer_table = self.tfidf_vectorizers.get(vectorizer_path)
        embeddings_table = self.tfidf_embeddings.get(embeddings_path)
        
        if vectorizer_table is None or embeddings_table is None:
            return None
            
        return {
            'vectorizer_table': vectorizer_table,
            'embeddings_table': embeddings_table
        }
    
    def get_preloaded_distllm_retriever(self, name: str) -> Optional[Any]:
        """
        Get preloaded distllm retriever for a database.
        
        Args:
            name: Database name
            
        Returns:
            FaissIndexV2 instance, or None if not found
        """
        if name not in self.loaded_configs:
            return None
            
        config = self.loaded_configs[name]
        if config['program'] != 'distllm':
            return None
            
        return self.distllm_retrievers.get(name)
    
    def get_preload_status(self) -> Dict[str, Any]:
        """
        Get status of preloaded databases.
        
        Returns:
            Dict containing preload status information
        """
        return {
            'loaded_configs': self.loaded_configs,
            'tfidf_count': len(self.tfidf_vectorizers),
            'distllm_count': len(self.distllm_retrievers)
        }

# Global preloader instance
_preloader = None

def get_preloader() -> VectorDatabasePreloader:
    """Get the global preloader instance."""
    global _preloader
    if _preloader is None:
        _preloader = VectorDatabasePreloader()
    return _preloader

def preload_databases() -> Dict[str, Any]:
    """Preload all active vector databases."""
    preloader = get_preloader()
    return preloader.preload_all_active_databases() 